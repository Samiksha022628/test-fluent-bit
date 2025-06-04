"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DeployingMicoserviceOnEksStack = void 0;
const cdk = require("aws-cdk-lib");
const eks = require("aws-cdk-lib/aws-eks");
const iam = require("aws-cdk-lib/aws-iam");
const fs = require("fs");
const yaml = require("yaml");
const path = require("path");
const lambda_layer_kubectl_v28_1 = require("@aws-cdk/lambda-layer-kubectl-v28");
const ec2 = require("aws-cdk-lib/aws-ec2");
class DeployingMicoserviceOnEksStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        const envconfigs = this.node.tryGetContext('envconfigs');
        const iamroleforcluster = new iam.Role(this, 'EksAdminRole', {
            assumedBy: new iam.AccountRootPrincipal(),
        });
        const vpc = new ec2.Vpc(this, 'vpc', {
            natGateways: 1,
            subnetConfiguration: [
                {
                    name: 'PrivateSubnet',
                    subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
                    cidrMask: 24,
                },
                {
                    name: 'PublicSubnet',
                    subnetType: ec2.SubnetType.PUBLIC,
                    cidrMask: 24,
                },
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
        const oidcProvider = cluster.openIdConnectProvider;
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
        const fluentBitNamespace = 'amazon-cloudwatch';
        const fluentBitManifestsDir = path.join(__dirname, '../manifests/fluent-bit');
        const fluentBitFiles = [
            'namespace-cloudwatch.yaml',
            'configmap.yaml',
            'daemon-set.yaml',
        ];
        const loadYamlManifest = (fileName) => yaml
            .parseAllDocuments(fs.readFileSync(path.join(fluentBitManifestsDir, fileName), 'utf8'))
            .map((doc) => doc.toJSON())
            .filter(Boolean);
        // Apply namespace manifest first
        const namespaceManifest = loadYamlManifest('namespace-cloudwatch.yaml');
        const fluentBitNs = cluster.addManifest('FluentBitNamespace', ...namespaceManifest);
        // Create the IRSA ServiceAccount via CDK, no need for service-account.yaml manifest
        const fluentBitSA = cluster.addServiceAccount('FluentBitSA', {
            name: 'fluent-bit',
            namespace: fluentBitNamespace,
        });
        fluentBitSA.node.addDependency(fluentBitNs);
        fluentBitSA.addToPrincipalPolicy(new iam.PolicyStatement({
            actions: [
                'logs:PutLogEvents',
                'logs:CreateLogStream',
                'logs:CreateLogGroup',
                'logs:DescribeLogStreams',
            ],
            resources: ['*'],
        }));
        // Load remaining Fluent Bit manifests, excluding service-account.yaml entirely
        const fluentBitOtherResources = fluentBitFiles
            .filter((f) => f !== 'namespace-cloudwatch.yaml') // service-account.yaml already removed from list
            .flatMap((file) => loadYamlManifest(file));
        const fluentBitResources = cluster.addManifest('FluentBitResources', ...fluentBitOtherResources);
        fluentBitResources.node.addDependency(fluentBitNs);
        fluentBitResources.node.addDependency(fluentBitSA);
        const manifestsDir = path.join(__dirname, '../manifests');
        const files = [
            'namespace.yaml',
            'rolebinding.yaml',
            'configMap-secret.yaml',
            'deployment.yaml',
            'HPA.yaml',
            'job.yaml',
        ];
        for (const envName of Object.keys(envconfigs)) {
            const config = envconfigs[envName];
            const placeholders = {
                '{{ENV}}': envName,
                '{{APP_VERSION}}': config.appVersion || '1.0.0',
                '{{REPLICA_COUNT}}': (config.replicaCount || 1).toString(),
                '{{REQUEST_CPU}}': config.requestCpu || '100m',
                '{{LIMIT_CPU}}': config.limitCpu || '200m',
                '{{FEATURE_FLAG}}': config.featureFlag === undefined ? 'false' : config.featureFlag.toString(),
            };
            const replacePlaceholders = (content) => {
                for (const [key, value] of Object.entries(placeholders)) {
                    content = content.replace(new RegExp(key, 'g'), value);
                }
                return content;
            };
            const allResources = files.flatMap((file) => {
                const content = replacePlaceholders(fs.readFileSync(path.join(manifestsDir, file), 'utf8'));
                return yaml
                    .parseAllDocuments(content)
                    .map((doc) => doc.toJSON())
                    .filter(Boolean);
            });
            const namespaceResources = allResources.filter((res) => res.kind === 'Namespace');
            const otherResources = allResources.filter((res) => res.kind !== 'Namespace');
            const namespaceManifest = cluster.addManifest(`NamespaceManifest-${envName}`, ...namespaceResources);
            const appManifest = cluster.addManifest(`AppManifests-${envName}`, ...otherResources);
            appManifest.node.addDependency(namespaceManifest);
        }
    }
}
exports.DeployingMicoserviceOnEksStack = DeployingMicoserviceOnEksStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidGVzdC1mbHVlbnQtYml0LXN0YWNrLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsidGVzdC1mbHVlbnQtYml0LXN0YWNrLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7OztBQUFBLG1DQUFtQztBQUVuQywyQ0FBMkM7QUFDM0MsMkNBQTJDO0FBQzNDLHlCQUF5QjtBQUN6Qiw2QkFBNkI7QUFDN0IsNkJBQTZCO0FBQzdCLGdGQUFvRTtBQUNwRSwyQ0FBMkM7QUFFM0MsTUFBYSw4QkFBK0IsU0FBUSxHQUFHLENBQUMsS0FBSztJQUMzRCxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQXNCO1FBQzlELEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXhCLE1BQU0sVUFBVSxHQUFHLElBQUksQ0FBQyxJQUFJLENBQUMsYUFBYSxDQUFDLFlBQVksQ0FBQyxDQUFDO1FBRXpELE1BQU0saUJBQWlCLEdBQUcsSUFBSSxHQUFHLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxjQUFjLEVBQUU7WUFDM0QsU0FBUyxFQUFFLElBQUksR0FBRyxDQUFDLG9CQUFvQixFQUFFO1NBQzFDLENBQUMsQ0FBQztRQUVILE1BQU0sR0FBRyxHQUFHLElBQUksR0FBRyxDQUFDLEdBQUcsQ0FBQyxJQUFJLEVBQUUsS0FBSyxFQUFFO1lBQ25DLFdBQVcsRUFBRSxDQUFDO1lBQ2QsbUJBQW1CLEVBQUU7Z0JBQ25CO29CQUNFLElBQUksRUFBRSxlQUFlO29CQUNyQixVQUFVLEVBQUUsR0FBRyxDQUFDLFVBQVUsQ0FBQyxtQkFBbUI7b0JBQzlDLFFBQVEsRUFBRSxFQUFFO2lCQUNiO2dCQUNEO29CQUNFLElBQUksRUFBRSxjQUFjO29CQUNwQixVQUFVLEVBQUUsR0FBRyxDQUFDLFVBQVUsQ0FBQyxNQUFNO29CQUNqQyxRQUFRLEVBQUUsRUFBRTtpQkFDYjthQUNGO1NBQ0YsQ0FBQyxDQUFDO1FBRUgsTUFBTSxPQUFPLEdBQUcsSUFBSSxHQUFH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QUFDLEdBQUcsQ0FBQyxJQUFJLEtBQUssV0FBVyxDQUFDLENBQUM7WUFDbEYsTUFBTSxjQUFjLEdBQUcsWUFBWSxDQUFDLE1BQU0sQ0FBQyxDQUFDLEdBQUcsRUFBRSxFQUFFLENBQUMsR0FBRyxDQUFDLElBQUksS0FBSyxXQUFXLENBQUMsQ0FBQztZQUU5RSxNQUFNLGlCQUFpQixHQUFHLE9BQU8sQ0FBQyxXQUFXLENBQzNDLHFCQUFxQixPQUFPLEVBQUUsRUFDOUIsR0FBRyxrQkFBa0IsQ0FDdEIsQ0FBQztZQUNGLE1BQU0sV0FBVyxHQUFHLE9BQU8sQ0FBQyxXQUFXLENBQ3JDLGdCQUFnQixPQUFPLEVBQUUsRUFDekIsR0FBRyxjQUFjLENBQ2xCLENBQUM7WUFFRixXQUFXLENBQUMsSUFBSSxDQUFDLGFBQWEsQ0FBQyxpQkFBaUIsQ0FBQyxDQUFDO1FBQ3BELENBQUM7SUFDSCxDQUFDO0NBQ0Y7QUE3S0Qsd0VBNktDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gJ2NvbnN0cnVjdHMnO1xuaW1wb3J0ICogYXMgZWtzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1la3MnO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gJ2F3cy1jZGstbGliL2F3cy1pYW0nO1xuaW1wb3J0ICogYXMgZnMgZnJvbSAnZnMnO1xuaW1wb3J0ICogYXMgeWFtbCBmcm9tICd5YW1sJztcbmltcG9ydCAqIGFzIHBhdGggZnJvbSAncGF0aCc7XG5pbXBvcnQgeyBLdWJlY3RsVjI4TGF5ZXIgfSBmcm9tICdAYXdzLWNkay9sYW1iZGEtbGF5ZXIta3ViZWN0bC12MjgnO1xuaW1wb3J0ICogYXMgZWMyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lYzInO1xuXG5leHBvcnQgY2xhc3MgRGVwbG95aW5nTWljb3NlcnZpY2VPbkVrc1N0YWNrIGV4dGVuZHMgY2RrLlN0YWNrIHtcbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM/OiBjZGsuU3RhY2tQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xuXG4gICAgY29uc3QgZW52Y29uZmlncyA9IHRoaXMubm9kZS50cnlHZXRDb250ZXh0KCdlbnZjb25maWdzJyk7XG5cbiAgICBjb25zdCBpYW1yb2xlZm9yY2x1c3RlciA9IG5ldyBpYW0uUm9sZSh0aGlzLCAnRWtzQWRtaW5Sb2xlJywge1xuICAgICAgYXNzdW1lZEJ5OiBuZXcgaWFtLkFjY291bnRSb290UHJpbmNpcGFsKCksXG4gICAgfSk7XG5cbiAgICBjb25zdCB2cGMgPSBuZXcgZWMyLlZwYyh0aGlzLCAndnBjJywge1xuICAgICAgbmF0R2F0ZXdheXM6IDEsXG4gICAgICBzdWJuZXRDb25maWd1cmF0aW9uOiBbXG4gICAgICAgIHtcbiAgICAgICAgICBuYW1lOiAnUHJpdmF0ZVN1Ym5ldCcsXG4gICAgICAgICAgc3VibmV0VHlwZTogZWMyLlN1Ym5ldFR5cGUuUFJJVkFURV9XSVRIX0VHUkVTUyxcbiAgICAgICAgICBjaWRyTWFzazogMjQsXG4gICAgICAgIH0sXG4gICAgICAgIHtcbiAgICAgICAgICBuYW1lOiAnUHVibGljU3VibmV0JyxcbiAgICAgICAgICBzdWJuZXRUeXBlOiBlYzIuU3VibmV0VHlwZS5QVUJMSUMsXG4gICAgICAgICAgY2lkck1hc2s6IDI0LFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICB9KTtcblxuICAgIGNvbnN0IGNsdXN0ZXIgPSBuZXcgZWtzLkNsdXN0ZXIodGhpcywgJ0Vrc0NsdXN0ZXInLCB7XG4gICAgICBjbHVzdGVyTmFtZTogJ0Vrc0NsdXN0ZXInLFxuICAgICAgZGVmYXVsdENhcGFjaXR5OiAwLFxuICAgICAgdnBjLFxuICAgICAgdmVyc2lvbjogZWtzLkt1YmVybmV0ZXNWZXJzaW9uLlYxXzI4LFxuICAgICAga3ViZWN0bExheWVyOiBuZXcgS3ViZWN0bFYyOExheWVyKHRoaXMsICdrdWJlY3RsJyksXG4gICAgICB2cGNTdWJuZXRzOiBbeyBzdWJuZXRUeXBlOiBlYzIuU3VibmV0VHlwZS5QUklWQVRFX1dJVEhfRUdSRVNTIH1dLFxuICAgICAgbWFzdGVyc1JvbGU6IGlhbXJvbGVmb3JjbHVzdGVyLFxuICAgIH0pO1xuXG4gICAgY29uc3Qgb2lkY1Byb3ZpZGVyID0gY2x1c3Rlci5vcGVuSWRDb25uZWN0UHJvdmlkZXI7XG5cbiAgICBjb25zdCBub2RlZ3JvdXAgPSBjbHVzdGVyLmFkZE5vZGVncm91cENhcGFjaXR5KCdOb2RlR3JvdXAnLCB7XG4gICAgICBkZXNpcmVkU2l6ZTogMixcbiAgICAgIGluc3RhbmNlVHlwZXM6IFtuZXcgZWMyLkluc3RhbmNlVHlwZSgndDMubWVkaXVtJyldLFxuICAgICAgcmVtb3RlQWNjZXNzOiB7IHNzaEtleU5hbWU6ICdkZW1vJyB9LFxuICAgIH0pO1xuXG4gICAgbm9kZWdyb3VwLnJvbGUuYWRkTWFuYWdlZFBvbGljeShcbiAgICAgIGlhbS5NYW5hZ2VkUG9saWN5LmZyb21Bd3NNYW5hZ2VkUG9saWN5TmFtZSgnQW1hem9uU1NNTWFuYWdlZEluc3RhbmNlQ29yZScpXG4gICAgKTtcblxuICAgIGNsdXN0ZXIuYXdzQXV0aC5hZGRSb2xlTWFwcGluZyhub2RlZ3JvdXAucm9sZSwge1xuICAgICAgdXNlcm5hbWU6ICdzeXN0ZW06bm9kZTp7e0VDMlByaXZhdGVETlNOYW1lfX0nLFxuICAgICAgZ3JvdXBzOiBbJ3N5c3RlbTpib290c3RyYXBwZXJzJywgJ3N5c3RlbTpub2RlcycsICdzeXN0ZW06bWFzdGVycyddLFxuICAgIH0pO1xuXG4gICAgY2x1c3Rlci5hZGRIZWxtQ2hhcnQoJ01ldHJpY3NTZXJ2ZXInLCB7XG4gICAgICBjaGFydDogJ21ldHJpY3Mtc2VydmVyJyxcbiAgICAgIHJlcG9zaXRvcnk6ICdodHRwczovL2t1YmVybmV0ZXMtc2lncy5naXRodWIuaW8vbWV0cmljcy1zZXJ2ZXIvJyxcbiAgICAgIHJlbGVhc2U6ICdtZXRyaWNzLXNlcnZlcicsXG4gICAgICBuYW1lc3BhY2U6ICdrdWJlLXN5c3RlbScsXG4gICAgICB2YWx1ZXM6IHtcbiAgICAgICAgYXJnczogW1xuICAgICAgICAgICctLWt1YmVsZXQtaW5zZWN1cmUtdGxzJyxcbiAgICAgICAgICAnLS1rdWJlbGV0LXByZWZlcnJlZC1hZGRyZXNzLXR5cGVzPUludGVybmFsSVAsSG9zdG5hbWUsRXh0ZXJuYWxJUCcsXG4gICAgICAgIF0sXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgY29uc3QgZmx1ZW50Qml0TmFtZXNwYWNlID0gJ2FtYXpvbi1jbG91ZHdhdGNoJztcblxuICAgIGNvbnN0IGZsdWVudEJpdE1hbmlmZXN0c0RpciA9IHBhdGguam9pbihfX2Rpcm5hbWUsICcuLi9tYW5pZmVzdHMvZmx1ZW50LWJpdCcpO1xuICAgIGNvbnN0IGZsdWVudEJpdEZpbGVzID0gW1xuICAgICAgJ25hbWVzcGFjZS1jbG91ZHdhdGNoLnlhbWwnLFxuICAgICAgJ2NvbmZpZ21hcC55YW1sJyxcbiAgICAgICdkYWVtb24tc2V0LnlhbWwnLFxuICAgIF07XG5cbiAgICBjb25zdCBsb2FkWWFtbE1hbmlmZXN0ID0gKGZpbGVOYW1lOiBzdHJpbmcpID0+XG4gICAgICB5YW1sXG4gICAgICAgIC5wYXJzZUFsbERvY3VtZW50cyhcbiAgICAgICAgICBmcy5yZWFkRmlsZVN5bmMocGF0aC5qb2luKGZsdWVudEJpdE1hbmlmZXN0c0RpciwgZmlsZU5hbWUpLCAndXRmOCcpXG4gICAgICAgIClcbiAgICAgICAgLm1hcCgoZG9jKSA9PiBkb2MudG9KU09OKCkpXG4gICAgICAgIC5maWx0ZXIoQm9vbGVhbik7XG5cbiAgICAvLyBBcHBseSBuYW1lc3BhY2UgbWFuaWZlc3QgZmlyc3RcbiAgICBjb25zdCBuYW1lc3BhY2VNYW5pZmVzdCA9IGxvYWRZYW1sTWFuaWZlc3QoJ25hbWVzcGFjZS1jbG91ZHdhdGNoLnlhbWwnKTtcbiAgICBjb25zdCBmbHVlbnRCaXROcyA9IGNsdXN0ZXIuYWRkTWFuaWZlc3QoJ0ZsdWVudEJpdE5hbWVzcGFjZScsIC4uLm5hbWVzcGFjZU1hbmlmZXN0KTtcblxuICAgIC8vIENyZWF0ZSB0aGUgSVJTQSBTZXJ2aWNlQWNjb3VudCB2aWEgQ0RLLCBubyBuZWVkIGZvciBzZXJ2aWNlLWFjY291bnQueWFtbCBtYW5pZmVzdFxuICAgIGNvbnN0IGZsdWVudEJpdFNBID0gY2x1c3Rlci5hZGRTZXJ2aWNlQWNjb3VudCgnRmx1ZW50Qml0U0EnLCB7XG4gICAgICBuYW1lOiAnZmx1ZW50LWJpdCcsXG4gICAgICBuYW1lc3BhY2U6IGZsdWVudEJpdE5hbWVzcGFjZSxcbiAgICB9KTtcbiAgICBmbHVlbnRCaXRTQS5ub2RlLmFkZERlcGVuZGVuY3koZmx1ZW50Qml0TnMpO1xuXG4gICAgZmx1ZW50Qml0U0EuYWRkVG9QcmluY2lwYWxQb2xpY3koXG4gICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICAnbG9nczpQdXRMb2dFdmVudHMnLFxuICAgICAgICAgICdsb2dzOkNyZWF0ZUxvZ1N0cmVhbScsXG4gICAgICAgICAgJ2xvZ3M6Q3JlYXRlTG9nR3JvdXAnLFxuICAgICAgICAgICdsb2dzOkRlc2NyaWJlTG9nU3RyZWFtcycsXG4gICAgICAgIF0sXG4gICAgICAgIHJlc291cmNlczogWycqJ10sXG4gICAgICB9KVxuICAgICk7XG5cbiAgICAvLyBMb2FkIHJlbWFpbmluZyBGbHVlbnQgQml0IG1hbmlmZXN0cywgZXhjbHVkaW5nIHNlcnZpY2UtYWNjb3VudC55YW1sIGVudGlyZWx5XG4gICAgY29uc3QgZmx1ZW50Qml0T3RoZXJSZXNvdXJjZXMgPSBmbHVlbnRCaXRGaWxlc1xuICAgICAgLmZpbHRlcigoZikgPT4gZiAhPT0gJ25hbWVzcGFjZS1jbG91ZHdhdGNoLnlhbWwnKSAvLyBzZXJ2aWNlLWFjY291bnQueWFtbCBhbHJlYWR5IHJlbW92ZWQgZnJvbSBsaXN0XG4gICAgICAuZmxhdE1hcCgoZmlsZSkgPT4gbG9hZFlhbWxNYW5pZmVzdChmaWxlKSk7XG5cbiAgICBjb25zdCBmbHVlbnRCaXRSZXNvdXJjZXMgPSBjbHVzdGVyLmFkZE1hbmlmZXN0KFxuICAgICAgJ0ZsdWVudEJpdFJlc291cmNlcycsXG4gICAgICAuLi5mbHVlbnRCaXRPdGhlclJlc291cmNlc1xuICAgICk7XG4gICAgZmx1ZW50Qml0UmVzb3VyY2VzLm5vZGUuYWRkRGVwZW5kZW5jeShmbHVlbnRCaXROcyk7XG4gICAgZmx1ZW50Qml0UmVzb3VyY2VzLm5vZGUuYWRkRGVwZW5kZW5jeShmbHVlbnRCaXRTQSk7XG5cbiAgICBjb25zdCBtYW5pZmVzdHNEaXIgPSBwYXRoLmpvaW4oX19kaXJuYW1lLCAnLi4vbWFuaWZlc3RzJyk7XG4gICAgY29uc3QgZmlsZXMgPSBbXG4gICAgICAnbmFtZXNwYWNlLnlhbWwnLFxuICAgICAgJ3JvbGViaW5kaW5nLnlhbWwnLFxuICAgICAgJ2NvbmZpZ01hcC1zZWNyZXQueWFtbCcsXG4gICAgICAnZGVwbG95bWVudC55YW1sJyxcbiAgICAgICdIUEEueWFtbCcsXG4gICAgICAnam9iLnlhbWwnLFxuICAgIF07XG5cbiAgICBmb3IgKGNvbnN0IGVudk5hbWUgb2YgT2JqZWN0LmtleXMoZW52Y29uZmlncykpIHtcbiAgICAgIGNvbnN0IGNvbmZpZyA9IGVudmNvbmZpZ3NbZW52TmFtZV07XG5cbiAgICAgIGNvbnN0IHBsYWNlaG9sZGVyczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgICAgICAgJ3t7RU5WfX0nOiBlbnZOYW1lLFxuICAgICAgICAne3tBUFBfVkVSU0lPTn19JzogY29uZmlnLmFwcFZlcnNpb24gfHwgJzEuMC4wJyxcbiAgICAgICAgJ3t7UkVQTElDQV9DT1VOVH19JzogKGNvbmZpZy5yZXBsaWNhQ291bnQgfHwgMSkudG9TdHJpbmcoKSxcbiAgICAgICAgJ3t7UkVRVUVTVF9DUFV9fSc6IGNvbmZpZy5yZXF1ZXN0Q3B1IHx8ICcxMDBtJyxcbiAgICAgICAgJ3t7TElNSVRfQ1BVfX0nOiBjb25maWcubGltaXRDcHUgfHwgJzIwMG0nLFxuICAgICAgICAne3tGRUFUVVJFX0ZMQUd9fSc6XG4gICAgICAgICAgY29uZmlnLmZlYXR1cmVGbGFnID09PSB1bmRlZmluZWQgPyAnZmFsc2UnIDogY29uZmlnLmZlYXR1cmVGbGFnLnRvU3RyaW5nKCksXG4gICAgICB9O1xuXG4gICAgICBjb25zdCByZXBsYWNlUGxhY2Vob2xkZXJzID0gKGNvbnRlbnQ6IHN0cmluZykgPT4ge1xuICAgICAgICBmb3IgKGNvbnN0IFtrZXksIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhwbGFjZWhvbGRlcnMpKSB7XG4gICAgICAgICAgY29udGVudCA9IGNvbnRlbnQucmVwbGFjZShuZXcgUmVnRXhwKGtleSwgJ2cnKSwgdmFsdWUpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBjb250ZW50O1xuICAgICAgfTtcblxuICAgICAgY29uc3QgYWxsUmVzb3VyY2VzID0gZmlsZXMuZmxhdE1hcCgoZmlsZSkgPT4ge1xuICAgICAgICBjb25zdCBjb250ZW50ID0gcmVwbGFjZVBsYWNlaG9sZGVycyhcbiAgICAgICAgICBmcy5yZWFkRmlsZVN5bmMocGF0aC5qb2luKG1hbmlmZXN0c0RpciwgZmlsZSksICd1dGY4JylcbiAgICAgICAgKTtcbiAgICAgICAgcmV0dXJuIHlhbWxcbiAgICAgICAgICAucGFyc2VBbGxEb2N1bWVudHMoY29udGVudClcbiAgICAgICAgICAubWFwKChkb2MpID0+IGRvYy50b0pTT04oKSlcbiAgICAgICAgICAuZmlsdGVyKEJvb2xlYW4pO1xuICAgICAgfSk7XG5cbiAgICAgIGNvbnN0IG5hbWVzcGFjZVJlc291cmNlcyA9IGFsbFJlc291cmNlcy5maWx0ZXIoKHJlcykgPT4gcmVzLmtpbmQgPT09ICdOYW1lc3BhY2UnKTtcbiAgICAgIGNvbnN0IG90aGVyUmVzb3VyY2VzID0gYWxsUmVzb3VyY2VzLmZpbHRlcigocmVzKSA9PiByZXMua2luZCAhPT0gJ05hbWVzcGFjZScpO1xuXG4gICAgICBjb25zdCBuYW1lc3BhY2VNYW5pZmVzdCA9IGNsdXN0ZXIuYWRkTWFuaWZlc3QoXG4gICAgICAgIGBOYW1lc3BhY2VNYW5pZmVzdC0ke2Vudk5hbWV9YCxcbiAgICAgICAgLi4ubmFtZXNwYWNlUmVzb3VyY2VzXG4gICAgICApO1xuICAgICAgY29uc3QgYXBwTWFuaWZlc3QgPSBjbHVzdGVyLmFkZE1hbmlmZXN0KFxuICAgICAgICBgQXBwTWFuaWZlc3RzLSR7ZW52TmFtZX1gLFxuICAgICAgICAuLi5vdGhlclJlc291cmNlc1xuICAgICAgKTtcblxuICAgICAgYXBwTWFuaWZlc3Qubm9kZS5hZGREZXBlbmRlbmN5KG5hbWVzcGFjZU1hbmlmZXN0KTtcbiAgICB9XG4gIH1cbn1cbiJdfQ==