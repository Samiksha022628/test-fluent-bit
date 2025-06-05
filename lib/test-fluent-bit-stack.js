"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DeployingMicroserviceOnEksStack = void 0;
const cdk = require("aws-cdk-lib");
const eks = require("aws-cdk-lib/aws-eks");
const iam = require("aws-cdk-lib/aws-iam");
const fs = require("fs");
const yaml = require("yaml");
const path = require("path");
const lambda_layer_kubectl_v28_1 = require("@aws-cdk/lambda-layer-kubectl-v28");
const ec2 = require("aws-cdk-lib/aws-ec2");
class DeployingMicroserviceOnEksStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        const envconfigs = this.node.tryGetContext('envconfigs');
        const iamroleforcluster = new iam.Role(this, 'EksAdminRole', {
            assumedBy: new iam.AccountRootPrincipal(),
        });
        const vpc = new ec2.Vpc(this, 'Vpc', {
            natGateways: 1,
            subnetConfiguration: [
                { name: 'PrivateSubnet', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
                { name: 'PublicSubnet', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
            ],
        });
        const cluster = new eks.Cluster(this, 'EksCluster', {
            clusterName: 'EksCluster',
            defaultCapacity: 0,
            vpc,
            version: eks.KubernetesVersion.V1_28,
            kubectlLayer: new lambda_layer_kubectl_v28_1.KubectlV28Layer(this, 'kubectl'),
            vpcSubnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
            mastersRole: iamroleforcluster,
        });
        const nodegroup = cluster.addNodegroupCapacity('NodeGroup', {
            desiredSize: 2,
            instanceTypes: [new ec2.InstanceType('t3.medium')],
            remoteAccess: { sshKeyName: 'demo' },
        });
        nodegroup.role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'));
        cluster.awsAuth.addRoleMapping(nodegroup.role, {
            username: 'system:node:{{EC2PrivateDNSName}}',
            groups: ['system:bootstrappers', 'system:nodes', 'system:masters'],
        });
        cluster.addHelmChart('MetricsServer', {
            chart: 'metrics-server',
            repository: 'https://kubernetes-sigs.github.io/metrics-server/',
            release: 'metrics-server',
            namespace: 'kube-system',
            values: {
                args: [
                    '--kubelet-insecure-tls',
                    '--kubelet-preferred-address-types=InternalIP,Hostname,ExternalIP',
                ],
            },
        });
        const namespaceManifestPath = path.join(__dirname, '..', 'manifests', 'namespace-cloudwatch.yaml');
        const cloudwatchNamespace = cluster.addManifest('CloudWatchNamespace', ...yaml.parseAllDocuments(fs.readFileSync(namespaceManifestPath, 'utf8')).map(doc => doc.toJSON()).filter(Boolean));
        const conditionJson = new cdk.CfnJson(this, 'OIDCCondition', {
            value: {
                [`${cluster.openIdConnectProvider.openIdConnectProviderIssuer}:sub`]: 'system:serviceaccount:amazon-cloudwatch:fluent-bit',
            },
        });
        const fluentBitSaRole = new iam.Role(this, 'FluentBitIRSA', {
            assumedBy: new iam.WebIdentityPrincipal(cluster.openIdConnectProvider.openIdConnectProviderArn, { StringEquals: conditionJson }),
        });
        fluentBitSaRole.addToPrincipalPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'logs:CreateLogGroup',
                'logs:CreateLogStream',
                'logs:PutLogEvents',
                'logs:DescribeLogStreams',
            ],
            resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/eks/*`],
        }));
        const valuesYamlPath = path.join(__dirname, '..', 'manifests', 'values.yaml');
        const values = yaml.parse(fs.readFileSync(valuesYamlPath, 'utf8'));
        const fluentBit = cluster.addHelmChart('FluentBit', {
            chart: 'aws-for-fluent-bit',
            repository: 'https://aws.github.io/eks-charts',
            release: 'fluent-bit',
            namespace: 'amazon-cloudwatch',
            createNamespace: false,
            values: {
                ...values,
                serviceAccount: {
                    create: true,
                    name: 'fluent-bit',
                    annotations: {
                        'eks.amazonaws.com/role-arn': fluentBitSaRole.roleArn,
                    },
                },
            },
        });
        fluentBit.node.addDependency(cloudwatchNamespace);
        // 🔁 Merged manifest deployment for all environments
        const manifestsDir = 'manifests';
        const files = [
            'namespace.yaml',
            'rolebinding.yaml',
            'configMap-secret.yaml',
            'deployment.yaml',
            'HPA.yaml',
            'job.yaml',
        ];
        const allEnvResources = [];
        for (const envName of Object.keys(envconfigs)) {
            const config = envconfigs[envName];
            const placeholders = {
                '{{ENV}}': envName,
                '{{APP_VERSION}}': config.appVersion || '1.0.0',
                '{{REPLICA_COUNT}}': (config.replicaCount || 1).toString(),
                '{{REQUEST_CPU}}': config.requestCpu || '100m',
                '{{LIMIT_CPU}}': config.limitCpu || '200m',
                '{{FEATURE_FLAG}}': config.featureFlag === undefined ? 'false' : config.featureFlag.toString(),
                '{{LOG_GROUP_NAME}}': `/eks/${envName}/app-logs`,
            };
            const replacePlaceholders = (content) => {
                for (const [key, value] of Object.entries(placeholders)) {
                    content = content.replace(new RegExp(key, 'g'), value);
                }
                return content;
            };
            for (const file of files) {
                const content = replacePlaceholders(fs.readFileSync(path.join(manifestsDir, file), 'utf8'));
                const docs = yaml.parseAllDocuments(content).map(doc => doc.toJSON()).filter(Boolean);
                allEnvResources.push(...docs);
            }
        }
        // Sort resources so Namespace is applied first
        const sortedAllResources = allEnvResources.sort((a, b) => {
            if (a.kind === 'Namespace')
                return -1;
            if (b.kind === 'Namespace')
                return 1;
            return 0;
        });
        const mergedManifest = cluster.addManifest('AllAppManifests', ...sortedAllResources);
        mergedManifest.node.addDependency(cloudwatchNamespace);
    }
}
exports.DeployingMicroserviceOnEksStack = DeployingMicroserviceOnEksStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidGVzdC1mbHVlbnQtYml0LXN0YWNrLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsidGVzdC1mbHVlbnQtYml0LXN0YWNrLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7OztBQUFBLG1DQUFtQztBQUVuQywyQ0FBMkM7QUFDM0MsMkNBQTJDO0FBQzNDLHlCQUF5QjtBQUN6Qiw2QkFBNkI7QUFDN0IsNkJBQTZCO0FBQzdCLGdGQUFvRTtBQUNwRSwyQ0FBMkM7QUFFM0MsTUFBYSwrQkFBZ0MsU0FBUSxHQUFHLENBQUMsS0FBSztJQUM1RCxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQXNCO1FBQzlELEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXhCLE1BQU0sVUFBVSxHQUFHLElBQUksQ0FBQyxJQUFJLENBQUMsYUFBYSxDQUFDLFlBQVksQ0FBQyxDQUFDO1FBRXpELE1BQU0saUJBQWlCLEdBQUcsSUFBSSxHQUFHLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxjQUFjLEVBQUU7WUFDM0QsU0FBUyxFQUFFLElBQUksR0FBRyxDQUFDLG9CQUFvQixFQUFFO1NBQzFDLENBQUMsQ0FBQztRQUVILE1BQU0sR0FBRyxHQUFHLElBQUksR0FBRyxDQUFDLEdBQUcsQ0FBQyxJQUFJLEVBQUUsS0FBSyxFQUFFO1lBQ25DLFdBQVcsRUFBRSxDQUFDO1lBQ2QsbUJBQW1CLEVBQUU7Z0JBQ25CLEVBQUUsSUFBSSxFQUFFLGVBQWUsRUFBRSxVQUFVLEVBQUUsR0FBRyxDQUFDLFVBQVUsQ0FBQyxtQkFBbUIsRUFBRSxRQUFRLEVBQUUsRUFBRSxFQUFFO2dCQUN2RixFQUFFLElBQUksRUFBRSxjQUFjLEVBQUUsVUFBVSxFQUFFLEdBQUcsQ0FBQyxVQUFVLENBQUMsTUFBTSxFQUFFLFFBQVEsRUFBRSxFQUFFLEVBQUU7YUFDMUU7U0FDRixDQUFDLENBQUM7UUFFSCxNQUFNLE9BQU8sR0FBRyxJQUFJLEdBQUcsQ0FBQyxPQUFP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Q0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxHQUFHLENBQUMsTUFBTSxFQUFFLENBQUMsQ0FBQyxNQUFNLENBQUMsT0FBTyxDQUFDLENBQUM7Z0JBQ3RGLGVBQWUsQ0FBQyxJQUFJLENBQUMsR0FBRyxJQUFJLENBQUMsQ0FBQztZQUNoQyxDQUFDO1FBQ0gsQ0FBQztRQUVELCtDQUErQztRQUMvQyxNQUFNLGtCQUFrQixHQUFHLGVBQWUsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLEVBQUU7WUFDdkQsSUFBSSxDQUFDLENBQUMsSUFBSSxLQUFLLFdBQVc7Z0JBQUUsT0FBTyxDQUFDLENBQUMsQ0FBQztZQUN0QyxJQUFJLENBQUMsQ0FBQyxJQUFJLEtBQUssV0FBVztnQkFBRSxPQUFPLENBQUMsQ0FBQztZQUNyQyxPQUFPLENBQUMsQ0FBQztRQUNYLENBQUMsQ0FBQyxDQUFDO1FBRUgsTUFBTSxjQUFjLEdBQUcsT0FBTyxDQUFDLFdBQVcsQ0FBQyxpQkFBaUIsRUFBRSxHQUFHLGtCQUFrQixDQUFDLENBQUM7UUFDckYsY0FBYyxDQUFDLElBQUksQ0FBQyxhQUFhLENBQUMsbUJBQW1CLENBQUMsQ0FBQztJQUN6RCxDQUFDO0NBQ0Y7QUE3SkQsMEVBNkpDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gJ2NvbnN0cnVjdHMnO1xuaW1wb3J0ICogYXMgZWtzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1la3MnO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gJ2F3cy1jZGstbGliL2F3cy1pYW0nO1xuaW1wb3J0ICogYXMgZnMgZnJvbSAnZnMnO1xuaW1wb3J0ICogYXMgeWFtbCBmcm9tICd5YW1sJztcbmltcG9ydCAqIGFzIHBhdGggZnJvbSAncGF0aCc7XG5pbXBvcnQgeyBLdWJlY3RsVjI4TGF5ZXIgfSBmcm9tICdAYXdzLWNkay9sYW1iZGEtbGF5ZXIta3ViZWN0bC12MjgnO1xuaW1wb3J0ICogYXMgZWMyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lYzInO1xuIFxuZXhwb3J0IGNsYXNzIERlcGxveWluZ01pY3Jvc2VydmljZU9uRWtzU3RhY2sgZXh0ZW5kcyBjZGsuU3RhY2sge1xuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wcz86IGNkay5TdGFja1Byb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkLCBwcm9wcyk7XG4gXG4gICAgY29uc3QgZW52Y29uZmlncyA9IHRoaXMubm9kZS50cnlHZXRDb250ZXh0KCdlbnZjb25maWdzJyk7XG4gXG4gICAgY29uc3QgaWFtcm9sZWZvcmNsdXN0ZXIgPSBuZXcgaWFtLlJvbGUodGhpcywgJ0Vrc0FkbWluUm9sZScsIHtcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5BY2NvdW50Um9vdFByaW5jaXBhbCgpLFxuICAgIH0pO1xuIFxuICAgIGNvbnN0IHZwYyA9IG5ldyBlYzIuVnBjKHRoaXMsICdWcGMnLCB7XG4gICAgICBuYXRHYXRld2F5czogMSxcbiAgICAgIHN1Ym5ldENvbmZpZ3VyYXRpb246IFtcbiAgICAgICAgeyBuYW1lOiAnUHJpdmF0ZVN1Ym5ldCcsIHN1Ym5ldFR5cGU6IGVjMi5TdWJuZXRUeXBlLlBSSVZBVEVfV0lUSF9FR1JFU1MsIGNpZHJNYXNrOiAyNCB9LFxuICAgICAgICB7IG5hbWU6ICdQdWJsaWNTdWJuZXQnLCBzdWJuZXRUeXBlOiBlYzIuU3VibmV0VHlwZS5QVUJMSUMsIGNpZHJNYXNrOiAyNCB9LFxuICAgICAgXSxcbiAgICB9KTtcbiBcbiAgICBjb25zdCBjbHVzdGVyID0gbmV3IGVrcy5DbHVzdGVyKHRoaXMsICdFa3NDbHVzdGVyJywge1xuICAgICAgY2x1c3Rlck5hbWU6ICdFa3NDbHVzdGVyJyxcbiAgICAgIGRlZmF1bHRDYXBhY2l0eTogMCxcbiAgICAgIHZwYyxcbiAgICAgIHZlcnNpb246IGVrcy5LdWJlcm5ldGVzVmVyc2lvbi5WMV8yOCxcbiAgICAgIGt1YmVjdGxMYXllcjogbmV3IEt1YmVjdGxWMjhMYXllcih0aGlzLCAna3ViZWN0bCcpLFxuICAgICAgdnBjU3VibmV0czogW3sgc3VibmV0VHlwZTogZWMyLlN1Ym5ldFR5cGUuUFJJVkFURV9XSVRIX0VHUkVTUyB9XSxcbiAgICAgIG1hc3RlcnNSb2xlOiBpYW1yb2xlZm9yY2x1c3RlcixcbiAgICB9KTtcbiBcbiAgICBjb25zdCBub2RlZ3JvdXAgPSBjbHVzdGVyLmFkZE5vZGVncm91cENhcGFjaXR5KCdOb2RlR3JvdXAnLCB7XG4gICAgICBkZXNpcmVkU2l6ZTogMixcbiAgICAgIGluc3RhbmNlVHlwZXM6IFtuZXcgZWMyLkluc3RhbmNlVHlwZSgndDMubWVkaXVtJyldLFxuICAgICAgcmVtb3RlQWNjZXNzOiB7IHNzaEtleU5hbWU6ICdkZW1vJyB9LFxuICAgIH0pO1xuIFxuICAgIG5vZGVncm91cC5yb2xlLmFkZE1hbmFnZWRQb2xpY3koaWFtLk1hbmFnZWRQb2xpY3kuZnJvbUF3c01hbmFnZWRQb2xpY3lOYW1lKCdBbWF6b25TU01NYW5hZ2VkSW5zdGFuY2VDb3JlJykpO1xuIFxuICAgIGNsdXN0ZXIuYXdzQXV0aC5hZGRSb2xlTWFwcGluZyhub2RlZ3JvdXAucm9sZSwge1xuICAgICAgdXNlcm5hbWU6ICdzeXN0ZW06bm9kZTp7e0VDMlByaXZhdGVETlNOYW1lfX0nLFxuICAgICAgZ3JvdXBzOiBbJ3N5c3RlbTpib290c3RyYXBwZXJzJywgJ3N5c3RlbTpub2RlcycsICdzeXN0ZW06bWFzdGVycyddLFxuICAgIH0pO1xuIFxuICAgIGNsdXN0ZXIuYWRkSGVsbUNoYXJ0KCdNZXRyaWNzU2VydmVyJywge1xuICAgICAgY2hhcnQ6ICdtZXRyaWNzLXNlcnZlcicsXG4gICAgICByZXBvc2l0b3J5OiAnaHR0cHM6Ly9rdWJlcm5ldGVzLXNpZ3MuZ2l0aHViLmlvL21ldHJpY3Mtc2VydmVyLycsXG4gICAgICByZWxlYXNlOiAnbWV0cmljcy1zZXJ2ZXInLFxuICAgICAgbmFtZXNwYWNlOiAna3ViZS1zeXN0ZW0nLFxuICAgICAgdmFsdWVzOiB7XG4gICAgICAgIGFyZ3M6IFtcbiAgICAgICAgICAnLS1rdWJlbGV0LWluc2VjdXJlLXRscycsXG4gICAgICAgICAgJy0ta3ViZWxldC1wcmVmZXJyZWQtYWRkcmVzcy10eXBlcz1JbnRlcm5hbElQLEhvc3RuYW1lLEV4dGVybmFsSVAnLFxuICAgICAgICBdLFxuICAgICAgfSxcbiAgICB9KTtcbiBcbiAgICBjb25zdCBuYW1lc3BhY2VNYW5pZmVzdFBhdGggPSBwYXRoLmpvaW4oX19kaXJuYW1lLCAnLi4nLCAnbWFuaWZlc3RzJywgJ25hbWVzcGFjZS1jbG91ZHdhdGNoLnlhbWwnKTtcbiAgICBjb25zdCBjbG91ZHdhdGNoTmFtZXNwYWNlID0gY2x1c3Rlci5hZGRNYW5pZmVzdCgnQ2xvdWRXYXRjaE5hbWVzcGFjZScsIC4uLnlhbWwucGFyc2VBbGxEb2N1bWVudHMoXG4gICAgICBmcy5yZWFkRmlsZVN5bmMobmFtZXNwYWNlTWFuaWZlc3RQYXRoLCAndXRmOCcpXG4gICAgKS5tYXAoZG9jID0+IGRvYy50b0pTT04oKSkuZmlsdGVyKEJvb2xlYW4pKTtcbiBcbiAgICBjb25zdCBjb25kaXRpb25Kc29uID0gbmV3IGNkay5DZm5Kc29uKHRoaXMsICdPSURDQ29uZGl0aW9uJywge1xuICAgICAgdmFsdWU6IHtcbiAgICAgICAgW2Ake2NsdXN0ZXIub3BlbklkQ29ubmVjdFByb3ZpZGVyLm9wZW5JZENvbm5lY3RQcm92aWRlcklzc3Vlcn06c3ViYF06XG4gICAgICAgICAgJ3N5c3RlbTpzZXJ2aWNlYWNjb3VudDphbWF6b24tY2xvdWR3YXRjaDpmbHVlbnQtYml0JyxcbiAgICAgIH0sXG4gICAgfSk7XG4gXG4gICAgY29uc3QgZmx1ZW50Qml0U2FSb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsICdGbHVlbnRCaXRJUlNBJywge1xuICAgICAgYXNzdW1lZEJ5OiBuZXcgaWFtLldlYklkZW50aXR5UHJpbmNpcGFsKFxuICAgICAgICBjbHVzdGVyLm9wZW5JZENvbm5lY3RQcm92aWRlci5vcGVuSWRDb25uZWN0UHJvdmlkZXJBcm4sXG4gICAgICAgIHsgU3RyaW5nRXF1YWxzOiBjb25kaXRpb25Kc29uIH1cbiAgICAgICksXG4gICAgfSk7XG4gXG4gICAgZmx1ZW50Qml0U2FSb2xlLmFkZFRvUHJpbmNpcGFsUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgJ2xvZ3M6Q3JlYXRlTG9nR3JvdXAnLFxuICAgICAgICAnbG9nczpDcmVhdGVMb2dTdHJlYW0nLFxuICAgICAgICAnbG9nczpQdXRMb2dFdmVudHMnLFxuICAgICAgICAnbG9nczpEZXNjcmliZUxvZ1N0cmVhbXMnLFxuICAgICAgXSxcbiAgICAgIHJlc291cmNlczogW2Bhcm46YXdzOmxvZ3M6JHt0aGlzLnJlZ2lvbn06JHt0aGlzLmFjY291bnR9OmxvZy1ncm91cDovZWtzLypgXSxcbiAgICB9KSk7XG4gXG4gICAgY29uc3QgdmFsdWVzWWFtbFBhdGggPSBwYXRoLmpvaW4oX19kaXJuYW1lLCAnLi4nLCAnbWFuaWZlc3RzJywgJ3ZhbHVlcy55YW1sJyk7XG4gICAgY29uc3QgdmFsdWVzID0geWFtbC5wYXJzZShmcy5yZWFkRmlsZVN5bmModmFsdWVzWWFtbFBhdGgsICd1dGY4JykpO1xuIFxuICAgIGNvbnN0IGZsdWVudEJpdCA9IGNsdXN0ZXIuYWRkSGVsbUNoYXJ0KCdGbHVlbnRCaXQnLCB7XG4gICAgICBjaGFydDogJ2F3cy1mb3ItZmx1ZW50LWJpdCcsXG4gICAgICByZXBvc2l0b3J5OiAnaHR0cHM6Ly9hd3MuZ2l0aHViLmlvL2Vrcy1jaGFydHMnLFxuICAgICAgcmVsZWFzZTogJ2ZsdWVudC1iaXQnLFxuICAgICAgbmFtZXNwYWNlOiAnYW1hem9uLWNsb3Vkd2F0Y2gnLFxuICAgICAgY3JlYXRlTmFtZXNwYWNlOiBmYWxzZSxcbiAgICAgIHZhbHVlczoge1xuICAgICAgICAuLi52YWx1ZXMsXG4gICAgICAgIHNlcnZpY2VBY2NvdW50OiB7XG4gICAgICAgICAgY3JlYXRlOiB0cnVlLFxuICAgICAgICAgIG5hbWU6ICdmbHVlbnQtYml0JyxcbiAgICAgICAgICBhbm5vdGF0aW9uczoge1xuICAgICAgICAgICAgJ2Vrcy5hbWF6b25hd3MuY29tL3JvbGUtYXJuJzogZmx1ZW50Qml0U2FSb2xlLnJvbGVBcm4sXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgfSk7XG4gXG4gICAgZmx1ZW50Qml0Lm5vZGUuYWRkRGVwZW5kZW5jeShjbG91ZHdhdGNoTmFtZXNwYWNlKTtcbiBcbiAgICAvLyDwn5SBIE1lcmdlZCBtYW5pZmVzdCBkZXBsb3ltZW50IGZvciBhbGwgZW52aXJvbm1lbnRzXG4gICAgY29uc3QgbWFuaWZlc3RzRGlyID0gJ21hbmlmZXN0cyc7XG4gICAgY29uc3QgZmlsZXMgPSBbXG4gICAgICAnbmFtZXNwYWNlLnlhbWwnLFxuICAgICAgJ3JvbGViaW5kaW5nLnlhbWwnLFxuICAgICAgJ2NvbmZpZ01hcC1zZWNyZXQueWFtbCcsXG4gICAgICAnZGVwbG95bWVudC55YW1sJyxcbiAgICAgICdIUEEueWFtbCcsXG4gICAgICAnam9iLnlhbWwnLFxuICAgIF07XG4gXG4gICAgY29uc3QgYWxsRW52UmVzb3VyY2VzID0gW107XG4gXG4gICAgZm9yIChjb25zdCBlbnZOYW1lIG9mIE9iamVjdC5rZXlzKGVudmNvbmZpZ3MpKSB7XG4gICAgICBjb25zdCBjb25maWcgPSBlbnZjb25maWdzW2Vudk5hbWVdO1xuIFxuICAgICAgY29uc3QgcGxhY2Vob2xkZXJzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuICAgICAgICAne3tFTlZ9fSc6IGVudk5hbWUsXG4gICAgICAgICd7e0FQUF9WRVJTSU9OfX0nOiBjb25maWcuYXBwVmVyc2lvbiB8fCAnMS4wLjAnLFxuICAgICAgICAne3tSRVBMSUNBX0NPVU5UfX0nOiAoY29uZmlnLnJlcGxpY2FDb3VudCB8fCAxKS50b1N0cmluZygpLFxuICAgICAgICAne3tSRVFVRVNUX0NQVX19JzogY29uZmlnLnJlcXVlc3RDcHUgfHwgJzEwMG0nLFxuICAgICAgICAne3tMSU1JVF9DUFV9fSc6IGNvbmZpZy5saW1pdENwdSB8fCAnMjAwbScsXG4gICAgICAgICd7e0ZFQVRVUkVfRkxBR319JzogY29uZmlnLmZlYXR1cmVGbGFnID09PSB1bmRlZmluZWQgPyAnZmFsc2UnIDogY29uZmlnLmZlYXR1cmVGbGFnLnRvU3RyaW5nKCksXG4gICAgICAgICd7e0xPR19HUk9VUF9OQU1FfX0nOiBgL2Vrcy8ke2Vudk5hbWV9L2FwcC1sb2dzYCxcbiAgICAgIH07XG4gXG4gICAgICBjb25zdCByZXBsYWNlUGxhY2Vob2xkZXJzID0gKGNvbnRlbnQ6IHN0cmluZykgPT4ge1xuICAgICAgICBmb3IgKGNvbnN0IFtrZXksIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhwbGFjZWhvbGRlcnMpKSB7XG4gICAgICAgICAgY29udGVudCA9IGNvbnRlbnQucmVwbGFjZShuZXcgUmVnRXhwKGtleSwgJ2cnKSwgdmFsdWUpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBjb250ZW50O1xuICAgICAgfTtcbiBcbiAgICAgIGZvciAoY29uc3QgZmlsZSBvZiBmaWxlcykge1xuICAgICAgICBjb25zdCBjb250ZW50ID0gcmVwbGFjZVBsYWNlaG9sZGVycyhmcy5yZWFkRmlsZVN5bmMocGF0aC5qb2luKG1hbmlmZXN0c0RpciwgZmlsZSksICd1dGY4JykpO1xuICAgICAgICBjb25zdCBkb2NzID0geWFtbC5wYXJzZUFsbERvY3VtZW50cyhjb250ZW50KS5tYXAoZG9jID0+IGRvYy50b0pTT04oKSkuZmlsdGVyKEJvb2xlYW4pO1xuICAgICAgICBhbGxFbnZSZXNvdXJjZXMucHVzaCguLi5kb2NzKTtcbiAgICAgIH1cbiAgICB9XG4gXG4gICAgLy8gU29ydCByZXNvdXJjZXMgc28gTmFtZXNwYWNlIGlzIGFwcGxpZWQgZmlyc3RcbiAgICBjb25zdCBzb3J0ZWRBbGxSZXNvdXJjZXMgPSBhbGxFbnZSZXNvdXJjZXMuc29ydCgoYSwgYikgPT4ge1xuICAgICAgaWYgKGEua2luZCA9PT0gJ05hbWVzcGFjZScpIHJldHVybiAtMTtcbiAgICAgIGlmIChiLmtpbmQgPT09ICdOYW1lc3BhY2UnKSByZXR1cm4gMTtcbiAgICAgIHJldHVybiAwO1xuICAgIH0pO1xuIFxuICAgIGNvbnN0IG1lcmdlZE1hbmlmZXN0ID0gY2x1c3Rlci5hZGRNYW5pZmVzdCgnQWxsQXBwTWFuaWZlc3RzJywgLi4uc29ydGVkQWxsUmVzb3VyY2VzKTtcbiAgICBtZXJnZWRNYW5pZmVzdC5ub2RlLmFkZERlcGVuZGVuY3koY2xvdWR3YXRjaE5hbWVzcGFjZSk7XG4gIH1cbn0iXX0=