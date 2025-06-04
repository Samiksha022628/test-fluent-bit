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
            'service-account.yaml',
            'configmap.yaml',
            'daemon-set.yaml',
        ];
        const loadYamlManifest = (fileName) => yaml
            .parseAllDocuments(fs.readFileSync(path.join(fluentBitManifestsDir, fileName), 'utf8'))
            .map((doc) => doc.toJSON())
            .filter(Boolean);
        const namespaceManifest = loadYamlManifest('namespace-cloudwatch.yaml');
        const fluentBitNs = cluster.addManifest('FluentBitNamespace', ...namespaceManifest);
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
        const fluentBitOtherResources = fluentBitFiles
            .filter((f) => f !== 'namespace-cloudwatch.yaml')
            .flatMap((file) => {
            if (file === 'service-account.yaml') {
                const saContent = fs
                    .readFileSync(path.join(fluentBitManifestsDir, file), 'utf8')
                    .replace('<IRSA_ROLE_ARN_PLACEHOLDER>', fluentBitSA.role.roleArn);
                return yaml
                    .parseAllDocuments(saContent)
                    .map((doc) => doc.toJSON())
                    .filter(Boolean);
            }
            return loadYamlManifest(file);
        });
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
                '{{FEATURE_FLAG}}': config.featureFlag === undefined
                    ? 'false'
                    : config.featureFlag.toString(),
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidGVzdC1mbHVlbnQtYml0LXN0YWNrLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsidGVzdC1mbHVlbnQtYml0LXN0YWNrLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7OztBQUFBLG1DQUFtQztBQUVuQywyQ0FBMkM7QUFDM0MsMkNBQTJDO0FBQzNDLHlCQUF5QjtBQUN6Qiw2QkFBNkI7QUFDN0IsNkJBQTZCO0FBQzdCLGdGQUFvRTtBQUNwRSwyQ0FBMkM7QUFFM0MsTUFBYSw4QkFBK0IsU0FBUSxHQUFHLENBQUMsS0FBSztJQUMzRCxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQXNCO1FBQzlELEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXhCLE1BQU0sVUFBVSxHQUFHLElBQUksQ0FBQyxJQUFJLENBQUMsYUFBYSxDQUFDLFlBQVksQ0FBQyxDQUFDO1FBRXpELE1BQU0saUJBQWlCLEdBQUcsSUFBSSxHQUFHLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxjQUFjLEVBQUU7WUFDM0QsU0FBUyxFQUFFLElBQUksR0FBRyxDQUFDLG9CQUFvQixFQUFFO1NBQzFDLENBQUMsQ0FBQztRQUVILE1BQU0sR0FBRyxHQUFHLElBQUksR0FBRyxDQUFDLEdBQUcsQ0FBQyxJQUFJLEVBQUUsS0FBSyxFQUFFO1lBQ25DLFdBQVcsRUFBRSxDQUFDO1lBQ2QsbUJBQW1CLEVBQUU7Z0JBQ25CO29CQUNFLElBQUksRUFBRSxlQUFlO29CQUNyQixVQUFVLEVBQUUsR0FBRyxDQUFDLFVBQVUsQ0FBQyxtQkFBbUI7b0JBQzlDLFFBQVEsRUFBRSxFQUFFO2lCQUNiO2dCQUNEO29CQUNFLElBQUksRUFBRSxjQUFjO29CQUNwQixVQUFVLEVBQUUsR0FBRyxDQUFDLFVBQVUsQ0FBQyxNQUFNO29CQUNqQyxRQUFRLEVBQUUsRUFBRTtpQkFDYjthQUNGO1NBQ0YsQ0FBQyxDQUFDO1FBRUgsTUFBTSxPQUFPLEdBQUcsSUFBSSxHQUFH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QVksQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLFlBQVksRUFBRSxJQUFJLENBQUMsRUFBRSxNQUFNLENBQUMsQ0FDdkQsQ0FBQztnQkFDRixPQUFPLElBQUk7cUJBQ1IsaUJBQWlCLENBQUMsT0FBTyxDQUFDO3FCQUMxQixHQUFHLENBQUMsQ0FBQyxHQUFHLEVBQUUsRUFBRSxDQUFDLEdBQUcsQ0FBQyxNQUFNLEVBQUUsQ0FBQztxQkFDMUIsTUFBTSxDQUFDLE9BQU8sQ0FBQyxDQUFDO1lBQ3JCLENBQUMsQ0FBQyxDQUFDO1lBRUgsTUFBTSxrQkFBa0IsR0FBRyxZQUFZLENBQUMsTUFBTSxDQUM1QyxDQUFDLEdBQUcsRUFBRSxFQUFFLENBQUMsR0FBRyxDQUFDLElBQUksS0FBSyxXQUFXLENBQ2xDLENBQUM7WUFDRixNQUFNLGNBQWMsR0FBRyxZQUFZLENBQUMsTUFBTSxDQUN4QyxDQUFDLEdBQUcsRUFBRSxFQUFFLENBQUMsR0FBRyxDQUFDLElBQUksS0FBSyxXQUFXLENBQ2xDLENBQUM7WUFFRixNQUFNLGlCQUFpQixHQUFHLE9BQU8sQ0FBQyxXQUFXLENBQzNDLHFCQUFxQixPQUFPLEVBQUUsRUFDOUIsR0FBRyxrQkFBa0IsQ0FDdEIsQ0FBQztZQUNGLE1BQU0sV0FBVyxHQUFHLE9BQU8sQ0FBQyxXQUFXLENBQ3JDLGdCQUFnQixPQUFPLEVBQUUsRUFDekIsR0FBRyxjQUFjLENBQ2xCLENBQUM7WUFFRixXQUFXLENBQUMsSUFBSSxDQUFDLGFBQWEsQ0FBQyxpQkFBaUIsQ0FBQyxDQUFDO1FBQ3BELENBQUM7SUFDSCxDQUFDO0NBQ0Y7QUE1TEQsd0VBNExDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gJ2NvbnN0cnVjdHMnO1xuaW1wb3J0ICogYXMgZWtzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1la3MnO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gJ2F3cy1jZGstbGliL2F3cy1pYW0nO1xuaW1wb3J0ICogYXMgZnMgZnJvbSAnZnMnO1xuaW1wb3J0ICogYXMgeWFtbCBmcm9tICd5YW1sJztcbmltcG9ydCAqIGFzIHBhdGggZnJvbSAncGF0aCc7XG5pbXBvcnQgeyBLdWJlY3RsVjI4TGF5ZXIgfSBmcm9tICdAYXdzLWNkay9sYW1iZGEtbGF5ZXIta3ViZWN0bC12MjgnO1xuaW1wb3J0ICogYXMgZWMyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lYzInO1xuXG5leHBvcnQgY2xhc3MgRGVwbG95aW5nTWljb3NlcnZpY2VPbkVrc1N0YWNrIGV4dGVuZHMgY2RrLlN0YWNrIHtcbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM/OiBjZGsuU3RhY2tQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xuXG4gICAgY29uc3QgZW52Y29uZmlncyA9IHRoaXMubm9kZS50cnlHZXRDb250ZXh0KCdlbnZjb25maWdzJyk7XG5cbiAgICBjb25zdCBpYW1yb2xlZm9yY2x1c3RlciA9IG5ldyBpYW0uUm9sZSh0aGlzLCAnRWtzQWRtaW5Sb2xlJywge1xuICAgICAgYXNzdW1lZEJ5OiBuZXcgaWFtLkFjY291bnRSb290UHJpbmNpcGFsKCksXG4gICAgfSk7XG5cbiAgICBjb25zdCB2cGMgPSBuZXcgZWMyLlZwYyh0aGlzLCAndnBjJywge1xuICAgICAgbmF0R2F0ZXdheXM6IDEsXG4gICAgICBzdWJuZXRDb25maWd1cmF0aW9uOiBbXG4gICAgICAgIHtcbiAgICAgICAgICBuYW1lOiAnUHJpdmF0ZVN1Ym5ldCcsXG4gICAgICAgICAgc3VibmV0VHlwZTogZWMyLlN1Ym5ldFR5cGUuUFJJVkFURV9XSVRIX0VHUkVTUyxcbiAgICAgICAgICBjaWRyTWFzazogMjQsXG4gICAgICAgIH0sXG4gICAgICAgIHtcbiAgICAgICAgICBuYW1lOiAnUHVibGljU3VibmV0JyxcbiAgICAgICAgICBzdWJuZXRUeXBlOiBlYzIuU3VibmV0VHlwZS5QVUJMSUMsXG4gICAgICAgICAgY2lkck1hc2s6IDI0LFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICB9KTtcblxuICAgIGNvbnN0IGNsdXN0ZXIgPSBuZXcgZWtzLkNsdXN0ZXIodGhpcywgJ0Vrc0NsdXN0ZXInLCB7XG4gICAgICBjbHVzdGVyTmFtZTogJ0Vrc0NsdXN0ZXInLFxuICAgICAgZGVmYXVsdENhcGFjaXR5OiAwLFxuICAgICAgdnBjLFxuICAgICAgdmVyc2lvbjogZWtzLkt1YmVybmV0ZXNWZXJzaW9uLlYxXzI4LFxuICAgICAga3ViZWN0bExheWVyOiBuZXcgS3ViZWN0bFYyOExheWVyKHRoaXMsICdrdWJlY3RsJyksXG4gICAgICB2cGNTdWJuZXRzOiBbeyBzdWJuZXRUeXBlOiBlYzIuU3VibmV0VHlwZS5QUklWQVRFX1dJVEhfRUdSRVNTIH1dLFxuICAgICAgbWFzdGVyc1JvbGU6IGlhbXJvbGVmb3JjbHVzdGVyLFxuICAgIH0pO1xuXG4gICAgY29uc3Qgbm9kZWdyb3VwID0gY2x1c3Rlci5hZGROb2RlZ3JvdXBDYXBhY2l0eSgnTm9kZUdyb3VwJywge1xuICAgICAgZGVzaXJlZFNpemU6IDIsXG4gICAgICBpbnN0YW5jZVR5cGVzOiBbbmV3IGVjMi5JbnN0YW5jZVR5cGUoJ3QzLm1lZGl1bScpXSxcbiAgICAgIHJlbW90ZUFjY2VzczogeyBzc2hLZXlOYW1lOiAnZGVtbycgfSxcbiAgICB9KTtcblxuICAgIG5vZGVncm91cC5yb2xlLmFkZE1hbmFnZWRQb2xpY3koXG4gICAgICBpYW0uTWFuYWdlZFBvbGljeS5mcm9tQXdzTWFuYWdlZFBvbGljeU5hbWUoXG4gICAgICAgICdBbWF6b25TU01NYW5hZ2VkSW5zdGFuY2VDb3JlJ1xuICAgICAgKVxuICAgICk7XG5cbiAgICBjbHVzdGVyLmF3c0F1dGguYWRkUm9sZU1hcHBpbmcobm9kZWdyb3VwLnJvbGUsIHtcbiAgICAgIHVzZXJuYW1lOiAnc3lzdGVtOm5vZGU6e3tFQzJQcml2YXRlRE5TTmFtZX19JyxcbiAgICAgIGdyb3VwczogWydzeXN0ZW06Ym9vdHN0cmFwcGVycycsICdzeXN0ZW06bm9kZXMnLCAnc3lzdGVtOm1hc3RlcnMnXSxcbiAgICB9KTtcblxuICAgIGNsdXN0ZXIuYWRkSGVsbUNoYXJ0KCdNZXRyaWNzU2VydmVyJywge1xuICAgICAgY2hhcnQ6ICdtZXRyaWNzLXNlcnZlcicsXG4gICAgICByZXBvc2l0b3J5OiAnaHR0cHM6Ly9rdWJlcm5ldGVzLXNpZ3MuZ2l0aHViLmlvL21ldHJpY3Mtc2VydmVyLycsXG4gICAgICByZWxlYXNlOiAnbWV0cmljcy1zZXJ2ZXInLFxuICAgICAgbmFtZXNwYWNlOiAna3ViZS1zeXN0ZW0nLFxuICAgICAgdmFsdWVzOiB7XG4gICAgICAgIGFyZ3M6IFtcbiAgICAgICAgICAnLS1rdWJlbGV0LWluc2VjdXJlLXRscycsXG4gICAgICAgICAgJy0ta3ViZWxldC1wcmVmZXJyZWQtYWRkcmVzcy10eXBlcz1JbnRlcm5hbElQLEhvc3RuYW1lLEV4dGVybmFsSVAnLFxuICAgICAgICBdLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIGNvbnN0IGZsdWVudEJpdE5hbWVzcGFjZSA9ICdhbWF6b24tY2xvdWR3YXRjaCc7XG5cbiAgICBjb25zdCBmbHVlbnRCaXRNYW5pZmVzdHNEaXIgPSBwYXRoLmpvaW4oX19kaXJuYW1lLCAnLi4vbWFuaWZlc3RzL2ZsdWVudC1iaXQnKTtcbiAgICBjb25zdCBmbHVlbnRCaXRGaWxlcyA9IFtcbiAgICAgICduYW1lc3BhY2UtY2xvdWR3YXRjaC55YW1sJyxcbiAgICAgICdzZXJ2aWNlLWFjY291bnQueWFtbCcsXG4gICAgICAnY29uZmlnbWFwLnlhbWwnLFxuICAgICAgJ2RhZW1vbi1zZXQueWFtbCcsXG4gICAgXTtcblxuICAgIGNvbnN0IGxvYWRZYW1sTWFuaWZlc3QgPSAoZmlsZU5hbWU6IHN0cmluZykgPT5cbiAgICAgIHlhbWxcbiAgICAgICAgLnBhcnNlQWxsRG9jdW1lbnRzKFxuICAgICAgICAgIGZzLnJlYWRGaWxlU3luYyhwYXRoLmpvaW4oZmx1ZW50Qml0TWFuaWZlc3RzRGlyLCBmaWxlTmFtZSksICd1dGY4JylcbiAgICAgICAgKVxuICAgICAgICAubWFwKChkb2MpID0+IGRvYy50b0pTT04oKSlcbiAgICAgICAgLmZpbHRlcihCb29sZWFuKTtcblxuICAgIGNvbnN0IG5hbWVzcGFjZU1hbmlmZXN0ID0gbG9hZFlhbWxNYW5pZmVzdCgnbmFtZXNwYWNlLWNsb3Vkd2F0Y2gueWFtbCcpO1xuICAgIGNvbnN0IGZsdWVudEJpdE5zID0gY2x1c3Rlci5hZGRNYW5pZmVzdCgnRmx1ZW50Qml0TmFtZXNwYWNlJywgLi4ubmFtZXNwYWNlTWFuaWZlc3QpO1xuXG4gICAgY29uc3QgZmx1ZW50Qml0U0EgPSBjbHVzdGVyLmFkZFNlcnZpY2VBY2NvdW50KCdGbHVlbnRCaXRTQScsIHtcbiAgICAgIG5hbWU6ICdmbHVlbnQtYml0JyxcbiAgICAgIG5hbWVzcGFjZTogZmx1ZW50Qml0TmFtZXNwYWNlLFxuICAgIH0pO1xuICAgIGZsdWVudEJpdFNBLm5vZGUuYWRkRGVwZW5kZW5jeShmbHVlbnRCaXROcyk7IFxuXG4gICAgZmx1ZW50Qml0U0EuYWRkVG9QcmluY2lwYWxQb2xpY3koXG4gICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICAnbG9nczpQdXRMb2dFdmVudHMnLFxuICAgICAgICAgICdsb2dzOkNyZWF0ZUxvZ1N0cmVhbScsXG4gICAgICAgICAgJ2xvZ3M6Q3JlYXRlTG9nR3JvdXAnLFxuICAgICAgICAgICdsb2dzOkRlc2NyaWJlTG9nU3RyZWFtcycsXG4gICAgICAgIF0sXG4gICAgICAgIHJlc291cmNlczogWycqJ10sXG4gICAgICB9KVxuICAgICk7XG5cbiAgICBjb25zdCBmbHVlbnRCaXRPdGhlclJlc291cmNlcyA9IGZsdWVudEJpdEZpbGVzXG4gICAgICAuZmlsdGVyKChmKSA9PiBmICE9PSAnbmFtZXNwYWNlLWNsb3Vkd2F0Y2gueWFtbCcpXG4gICAgICAuZmxhdE1hcCgoZmlsZSkgPT4ge1xuICAgICAgICBpZiAoZmlsZSA9PT0gJ3NlcnZpY2UtYWNjb3VudC55YW1sJykge1xuICAgICAgICAgIGNvbnN0IHNhQ29udGVudCA9IGZzXG4gICAgICAgICAgICAucmVhZEZpbGVTeW5jKHBhdGguam9pbihmbHVlbnRCaXRNYW5pZmVzdHNEaXIsIGZpbGUpLCAndXRmOCcpXG4gICAgICAgICAgICAucmVwbGFjZSgnPElSU0FfUk9MRV9BUk5fUExBQ0VIT0xERVI+JywgZmx1ZW50Qml0U0Eucm9sZS5yb2xlQXJuKTtcbiAgICAgICAgICByZXR1cm4geWFtbFxuICAgICAgICAgICAgLnBhcnNlQWxsRG9jdW1lbnRzKHNhQ29udGVudClcbiAgICAgICAgICAgIC5tYXAoKGRvYykgPT4gZG9jLnRvSlNPTigpKVxuICAgICAgICAgICAgLmZpbHRlcihCb29sZWFuKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gbG9hZFlhbWxNYW5pZmVzdChmaWxlKTtcbiAgICAgIH0pO1xuXG4gICAgY29uc3QgZmx1ZW50Qml0UmVzb3VyY2VzID0gY2x1c3Rlci5hZGRNYW5pZmVzdChcbiAgICAgICdGbHVlbnRCaXRSZXNvdXJjZXMnLFxuICAgICAgLi4uZmx1ZW50Qml0T3RoZXJSZXNvdXJjZXNcbiAgICApO1xuICAgIGZsdWVudEJpdFJlc291cmNlcy5ub2RlLmFkZERlcGVuZGVuY3koZmx1ZW50Qml0TnMpOyBcbiAgICBmbHVlbnRCaXRSZXNvdXJjZXMubm9kZS5hZGREZXBlbmRlbmN5KGZsdWVudEJpdFNBKTsgXG5cbiAgICBjb25zdCBtYW5pZmVzdHNEaXIgPSBwYXRoLmpvaW4oX19kaXJuYW1lLCAnLi4vbWFuaWZlc3RzJyk7XG4gICAgY29uc3QgZmlsZXMgPSBbXG4gICAgICAnbmFtZXNwYWNlLnlhbWwnLFxuICAgICAgJ3JvbGViaW5kaW5nLnlhbWwnLFxuICAgICAgJ2NvbmZpZ01hcC1zZWNyZXQueWFtbCcsXG4gICAgICAnZGVwbG95bWVudC55YW1sJyxcbiAgICAgICdIUEEueWFtbCcsXG4gICAgICAnam9iLnlhbWwnLFxuICAgIF07XG5cbiAgICBmb3IgKGNvbnN0IGVudk5hbWUgb2YgT2JqZWN0LmtleXMoZW52Y29uZmlncykpIHtcbiAgICAgIGNvbnN0IGNvbmZpZyA9IGVudmNvbmZpZ3NbZW52TmFtZV07XG5cbiAgICAgIGNvbnN0IHBsYWNlaG9sZGVyczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgICAgICAgJ3t7RU5WfX0nOiBlbnZOYW1lLFxuICAgICAgICAne3tBUFBfVkVSU0lPTn19JzogY29uZmlnLmFwcFZlcnNpb24gfHwgJzEuMC4wJyxcbiAgICAgICAgJ3t7UkVQTElDQV9DT1VOVH19JzogKGNvbmZpZy5yZXBsaWNhQ291bnQgfHwgMSkudG9TdHJpbmcoKSxcbiAgICAgICAgJ3t7UkVRVUVTVF9DUFV9fSc6IGNvbmZpZy5yZXF1ZXN0Q3B1IHx8ICcxMDBtJyxcbiAgICAgICAgJ3t7TElNSVRfQ1BVfX0nOiBjb25maWcubGltaXRDcHUgfHwgJzIwMG0nLFxuICAgICAgICAne3tGRUFUVVJFX0ZMQUd9fSc6XG4gICAgICAgICAgY29uZmlnLmZlYXR1cmVGbGFnID09PSB1bmRlZmluZWRcbiAgICAgICAgICAgID8gJ2ZhbHNlJ1xuICAgICAgICAgICAgOiBjb25maWcuZmVhdHVyZUZsYWcudG9TdHJpbmcoKSxcbiAgICAgIH07XG5cbiAgICAgIGNvbnN0IHJlcGxhY2VQbGFjZWhvbGRlcnMgPSAoY29udGVudDogc3RyaW5nKSA9PiB7XG4gICAgICAgIGZvciAoY29uc3QgW2tleSwgdmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKHBsYWNlaG9sZGVycykpIHtcbiAgICAgICAgICBjb250ZW50ID0gY29udGVudC5yZXBsYWNlKG5ldyBSZWdFeHAoa2V5LCAnZycpLCB2YWx1ZSk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGNvbnRlbnQ7XG4gICAgICB9O1xuXG4gICAgICBjb25zdCBhbGxSZXNvdXJjZXMgPSBmaWxlcy5mbGF0TWFwKChmaWxlKSA9PiB7XG4gICAgICAgIGNvbnN0IGNvbnRlbnQgPSByZXBsYWNlUGxhY2Vob2xkZXJzKFxuICAgICAgICAgIGZzLnJlYWRGaWxlU3luYyhwYXRoLmpvaW4obWFuaWZlc3RzRGlyLCBmaWxlKSwgJ3V0ZjgnKVxuICAgICAgICApO1xuICAgICAgICByZXR1cm4geWFtbFxuICAgICAgICAgIC5wYXJzZUFsbERvY3VtZW50cyhjb250ZW50KVxuICAgICAgICAgIC5tYXAoKGRvYykgPT4gZG9jLnRvSlNPTigpKVxuICAgICAgICAgIC5maWx0ZXIoQm9vbGVhbik7XG4gICAgICB9KTtcblxuICAgICAgY29uc3QgbmFtZXNwYWNlUmVzb3VyY2VzID0gYWxsUmVzb3VyY2VzLmZpbHRlcihcbiAgICAgICAgKHJlcykgPT4gcmVzLmtpbmQgPT09ICdOYW1lc3BhY2UnXG4gICAgICApO1xuICAgICAgY29uc3Qgb3RoZXJSZXNvdXJjZXMgPSBhbGxSZXNvdXJjZXMuZmlsdGVyKFxuICAgICAgICAocmVzKSA9PiByZXMua2luZCAhPT0gJ05hbWVzcGFjZSdcbiAgICAgICk7XG5cbiAgICAgIGNvbnN0IG5hbWVzcGFjZU1hbmlmZXN0ID0gY2x1c3Rlci5hZGRNYW5pZmVzdChcbiAgICAgICAgYE5hbWVzcGFjZU1hbmlmZXN0LSR7ZW52TmFtZX1gLFxuICAgICAgICAuLi5uYW1lc3BhY2VSZXNvdXJjZXNcbiAgICAgICk7XG4gICAgICBjb25zdCBhcHBNYW5pZmVzdCA9IGNsdXN0ZXIuYWRkTWFuaWZlc3QoXG4gICAgICAgIGBBcHBNYW5pZmVzdHMtJHtlbnZOYW1lfWAsXG4gICAgICAgIC4uLm90aGVyUmVzb3VyY2VzXG4gICAgICApO1xuXG4gICAgICBhcHBNYW5pZmVzdC5ub2RlLmFkZERlcGVuZGVuY3kobmFtZXNwYWNlTWFuaWZlc3QpO1xuICAgIH1cbiAgfVxufVxuIl19