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
                { name: 'PrivateSubnet', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24, },
                { name: 'PublicSubnet', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24, },
            ],
        });
        const cluster = new eks.Cluster(this, 'EksCluster', { clusterName: 'EksCluster',
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
            remoteAccess: { sshKeyName: 'demo',
            },
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
            values: { args: [
                    '--kubelet-insecure-tls',
                    '--kubelet-preferred-address-types=InternalIP,Hostname,ExternalIP',
                ], },
        });
        const fluentBitNamespace = 'amazon-cloudwatch';
        const fluentBitSA = cluster.addServiceAccount('FluentBitSA', {
            name: 'fluent-bit',
            namespace: fluentBitNamespace,
        });
        fluentBitSA.addToPrincipalPolicy(new iam.PolicyStatement({
            actions: [
                'logs:PutLogEvents',
                'logs:CreateLogStream',
                'logs:CreateLogGroup',
                'logs:DescribeLogStreams',
            ],
            resources: ['*'],
        }));
        const fluentBitManifestsDir = path.join(__dirname, '../manifests/fluent-bit');
        const fluentBitFiles = ['namespace-cloudwatch.yaml', 'service-account.yaml', 'configmap.yaml', 'daemon-set.yaml'];
        const loadYamlManifest = (fileName) => yaml.parseAllDocuments(fs.readFileSync(path.join(fluentBitManifestsDir, fileName), 'utf8'))
            .map(doc => doc.toJSON())
            .filter(Boolean);
        const namespaceManifest = loadYamlManifest('namespace-cloudwatch.yaml');
        const fluentBitOtherResources = fluentBitFiles
            .filter(f => f !== 'namespace-cloudwatch.yaml') // ❗ Important fix
            .flatMap(file => {
            if (file === 'service-account.yaml') {
                const saContent = fs.readFileSync(path.join(fluentBitManifestsDir, file), 'utf8')
                    .replace('<IRSA_ROLE_ARN_PLACEHOLDER>', fluentBitSA.role.roleArn);
                return yaml.parseAllDocuments(saContent).map(doc => doc.toJSON()).filter(Boolean);
            }
            return loadYamlManifest(file);
        });
        const fluentBitNs = cluster.addManifest('FluentBitNamespace', ...namespaceManifest);
        const fluentBitResources = cluster.addManifest('FluentBitResources', ...fluentBitOtherResources);
        fluentBitResources.node.addDependency(fluentBitNs);
        const manifestsDir = path.join(__dirname, '../manifests');
        const files = ['namespace.yaml', 'rolebinding.yaml', 'configMap-secret.yaml', 'deployment.yaml', 'HPA.yaml', 'job.yaml'];
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
                return yaml.parseAllDocuments(content).map((doc) => doc.toJSON()).filter(Boolean);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidGVzdC1mbHVlbnQtYml0LXN0YWNrLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsidGVzdC1mbHVlbnQtYml0LXN0YWNrLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7OztBQUFBLG1DQUFtQztBQUVuQywyQ0FBMkM7QUFDM0MsMkNBQTJDO0FBQzNDLHlCQUF5QjtBQUN6Qiw2QkFBNkI7QUFDN0IsNkJBQTZCO0FBQzdCLGdGQUFvRTtBQUNwRSwyQ0FBMkM7QUFFM0MsTUFBYSw4QkFBK0IsU0FBUSxHQUFHLENBQUMsS0FBSztJQUMzRCxZQUFZLEtBQWUsRUFBRSxFQUFTLEVBQUUsS0FBcUI7UUFBRyxLQUFLLENBQUMsS0FBSyxFQUFDLEVBQUUsRUFBQyxLQUFLLENBQUMsQ0FBQztRQUVwRixNQUFNLFVBQVUsR0FBRyxJQUFJLENBQUMsSUFBSSxDQUFDLGFBQWEsQ0FBQyxZQUFZLENBQUMsQ0FBQztRQUV6RCxNQUFNLGlCQUFpQixHQUFHLElBQUksR0FBRyxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsY0FBYyxFQUFFO1lBQzNELFNBQVMsRUFBRSxJQUFJLEdBQUcsQ0FBQyxvQkFBb0IsRUFBRTtTQUMxQyxDQUFDLENBQUM7UUFFSixNQUFNLEdBQUcsR0FBQyxJQUFJLEdBQUcsQ0FBQyxHQUFHLENBQUMsSUFBSSxFQUFDLEtBQUssRUFBQztZQUM5QixXQUFXLEVBQUUsQ0FBQztZQUNkLG1CQUFtQixFQUFFO2dCQUNuQixFQUFDLElBQUksRUFBRSxlQUFlLEVBQUUsVUFBVSxFQUFFLEdBQUcsQ0FBQyxVQUFVLENBQUMsbUJBQW1CLEVBQUUsUUFBUSxFQUFFLEVBQUUsR0FBRTtnQkFDdEYsRUFBQyxJQUFJLEVBQUUsY0FBYyxFQUFFLFVBQVUsRUFBRSxHQUFHLENBQUMsVUFBVSxDQUFDLE1BQU0sRUFBRSxRQUFRLEVBQUUsRUFBRSxHQUFFO2FBQ3pFO1NBQ0YsQ0FBQyxDQUFDO1FBRUgsTUFBTSxPQUFPLEdBQUMsSUFBSSxHQUFHLENBQUMsT0FBTyxD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RSxDQUFDLEdBQUcsQ0FBQyxNQUFNLEVBQUUsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxPQUFPLENBQUMsQ0FBQztZQUNwRixDQUFDLENBQUMsQ0FBQztZQUVILE1BQU0sa0JBQWtCLEdBQUcsWUFBWSxDQUFDLE1BQU0sQ0FBQyxDQUFDLEdBQUcsRUFBRSxFQUFFLENBQUMsR0FBRyxDQUFDLElBQUksS0FBSyxXQUFXLENBQUMsQ0FBQztZQUNsRixNQUFNLGNBQWMsR0FBRyxZQUFZLENBQUMsTUFBTSxDQUFDLENBQUMsR0FBRyxFQUFFLEVBQUUsQ0FBQyxHQUFHLENBQUMsSUFBSSxLQUFLLFdBQVcsQ0FBQyxDQUFDO1lBRTlFLE1BQU0saUJBQWlCLEdBQUcsT0FBTyxDQUFDLFdBQVcsQ0FBQyxxQkFBcUIsT0FBTyxFQUFFLEVBQUMsR0FBRyxrQkFBa0IsQ0FBQyxDQUFDO1lBQ3BHLE1BQU0sV0FBVyxHQUFHLE9BQU8sQ0FBQyxXQUFXLENBQUMsZ0JBQWdCLE9BQU8sRUFBRSxFQUFDLEdBQUcsY0FBYyxDQUFDLENBQUM7WUFFckYsV0FBVyxDQUFDLElBQUksQ0FBQyxhQUFhLENBQUMsaUJBQWlCLENBQUMsQ0FBQztRQUNwRCxDQUFDO0lBQ0gsQ0FBQztDQUFDO0FBbElKLHdFQWtJSSIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tICdjb25zdHJ1Y3RzJztcbmltcG9ydCAqIGFzIGVrcyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWtzJztcbmltcG9ydCAqIGFzIGlhbSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtaWFtJztcbmltcG9ydCAqIGFzIGZzIGZyb20gJ2ZzJztcbmltcG9ydCAqIGFzIHlhbWwgZnJvbSAneWFtbCc7XG5pbXBvcnQgKiBhcyBwYXRoIGZyb20gJ3BhdGgnO1xuaW1wb3J0IHsgS3ViZWN0bFYyOExheWVyIH0gZnJvbSAnQGF3cy1jZGsvbGFtYmRhLWxheWVyLWt1YmVjdGwtdjI4JztcbmltcG9ydCAqIGFzIGVjMiBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWMyJztcblxuZXhwb3J0IGNsYXNzIERlcGxveWluZ01pY29zZXJ2aWNlT25Fa3NTdGFjayBleHRlbmRzIGNkay5TdGFja3tcbiAgY29uc3RydWN0b3Ioc2NvcGU6Q29uc3RydWN0LCBpZDpzdHJpbmcsIHByb3BzPzpjZGsuU3RhY2tQcm9wcykge3N1cGVyKHNjb3BlLGlkLHByb3BzKTtcblxuICAgIGNvbnN0IGVudmNvbmZpZ3MgPSB0aGlzLm5vZGUudHJ5R2V0Q29udGV4dCgnZW52Y29uZmlncycpO1xuXG4gICAgY29uc3QgaWFtcm9sZWZvcmNsdXN0ZXIgPSBuZXcgaWFtLlJvbGUodGhpcywgJ0Vrc0FkbWluUm9sZScsIHtcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5BY2NvdW50Um9vdFByaW5jaXBhbCgpLFxuICAgIH0pO1xuXG4gICBjb25zdCB2cGM9bmV3IGVjMi5WcGModGhpcywndnBjJyx7XG4gICAgICBuYXRHYXRld2F5czogMSxcbiAgICAgIHN1Ym5ldENvbmZpZ3VyYXRpb246IFtcbiAgICAgICAge25hbWU6ICdQcml2YXRlU3VibmV0Jywgc3VibmV0VHlwZTogZWMyLlN1Ym5ldFR5cGUuUFJJVkFURV9XSVRIX0VHUkVTUywgY2lkck1hc2s6IDI0LH0sXG4gICAgICAgIHtuYW1lOiAnUHVibGljU3VibmV0Jywgc3VibmV0VHlwZTogZWMyLlN1Ym5ldFR5cGUuUFVCTElDLCBjaWRyTWFzazogMjQsfSxcbiAgICAgIF0sXG4gICAgfSk7XG5cbiAgICBjb25zdCBjbHVzdGVyPW5ldyBla3MuQ2x1c3Rlcih0aGlzLCAnRWtzQ2x1c3RlcicsIFxuICAgICAgICB7Y2x1c3Rlck5hbWU6ICdFa3NDbHVzdGVyJyxcbiAgICAgICAgICBkZWZhdWx0Q2FwYWNpdHk6MCxcbiAgICAgICAgICB2cGMsXG4gICAgICAgICAgdmVyc2lvbjogZWtzLkt1YmVybmV0ZXNWZXJzaW9uLlYxXzI4LFxuICAgICAgICAgIGt1YmVjdGxMYXllcjogbmV3IEt1YmVjdGxWMjhMYXllcih0aGlzLCAna3ViZWN0bCcpLFxuICAgICAgICAgIHZwY1N1Ym5ldHM6W3tzdWJuZXRUeXBlOmVjMi5TdWJuZXRUeXBlLlBSSVZBVEVfV0lUSF9FR1JFU1N9XSxcbiAgICAgICAgICBtYXN0ZXJzUm9sZTppYW1yb2xlZm9yY2x1c3RlcixcbiAgICAgICAgICAgfSlcbiAgICAgICAgICAgIFxuICAgICAgICBjb25zdCBub2RlZ3JvdXA9Y2x1c3Rlci5hZGROb2RlZ3JvdXBDYXBhY2l0eSgnTm9kZUdyb3VwJyx7XG4gICAgICAgIGRlc2lyZWRTaXplOjIsXG4gICAgICAgIGluc3RhbmNlVHlwZXM6IFtuZXcgZWMyLkluc3RhbmNlVHlwZSgndDMubWVkaXVtJyldLFxuICAgICAgICByZW1vdGVBY2Nlc3M6IHsgc3NoS2V5TmFtZTogJ2RlbW8nLFxuICAgICAgICB9LFxuICAgICAgfSk7XG5cbiAgICAgIG5vZGVncm91cC5yb2xlLmFkZE1hbmFnZWRQb2xpY3koaWFtLk1hbmFnZWRQb2xpY3kuZnJvbUF3c01hbmFnZWRQb2xpY3lOYW1lXG4gICAgICAgICgnQW1hem9uU1NNTWFuYWdlZEluc3RhbmNlQ29yZScpKTtcbiAgICAgIFxuICAgICAgY2x1c3Rlci5hd3NBdXRoLmFkZFJvbGVNYXBwaW5nKG5vZGVncm91cC5yb2xlLCB7XG4gICAgICAgIHVzZXJuYW1lOiAnc3lzdGVtOm5vZGU6e3tFQzJQcml2YXRlRE5TTmFtZX19JyxcbiAgICAgICAgZ3JvdXBzOiBbJ3N5c3RlbTpib290c3RyYXBwZXJzJywgJ3N5c3RlbTpub2RlcycsICdzeXN0ZW06bWFzdGVycyddLFxuICAgICB9KTtcblxuICAgICAgY2x1c3Rlci5hZGRIZWxtQ2hhcnQoJ01ldHJpY3NTZXJ2ZXInLCB7XG4gICAgICAgIGNoYXJ0OiAnbWV0cmljcy1zZXJ2ZXInLFxuICAgICAgICByZXBvc2l0b3J5OiAnaHR0cHM6Ly9rdWJlcm5ldGVzLXNpZ3MuZ2l0aHViLmlvL21ldHJpY3Mtc2VydmVyLycsXG4gICAgICAgIHJlbGVhc2U6ICdtZXRyaWNzLXNlcnZlcicsXG4gICAgICAgIG5hbWVzcGFjZTogJ2t1YmUtc3lzdGVtJyxcbiAgICAgICAgdmFsdWVzOiB7YXJnczogW1xuICAgICAgICAnLS1rdWJlbGV0LWluc2VjdXJlLXRscycsXG4gICAgICAgICctLWt1YmVsZXQtcHJlZmVycmVkLWFkZHJlc3MtdHlwZXM9SW50ZXJuYWxJUCxIb3N0bmFtZSxFeHRlcm5hbElQJyxdLH0sXG4gICAgICB9KTtcblxuICAgICAgY29uc3QgZmx1ZW50Qml0TmFtZXNwYWNlID0gJ2FtYXpvbi1jbG91ZHdhdGNoJztcblxuY29uc3QgZmx1ZW50Qml0U0EgPSBjbHVzdGVyLmFkZFNlcnZpY2VBY2NvdW50KCdGbHVlbnRCaXRTQScsIHtcbiAgbmFtZTogJ2ZsdWVudC1iaXQnLFxuICBuYW1lc3BhY2U6IGZsdWVudEJpdE5hbWVzcGFjZSxcbn0pO1xuXG5mbHVlbnRCaXRTQS5hZGRUb1ByaW5jaXBhbFBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gIGFjdGlvbnM6IFtcbiAgICAnbG9nczpQdXRMb2dFdmVudHMnLFxuICAgICdsb2dzOkNyZWF0ZUxvZ1N0cmVhbScsXG4gICAgJ2xvZ3M6Q3JlYXRlTG9nR3JvdXAnLFxuICAgICdsb2dzOkRlc2NyaWJlTG9nU3RyZWFtcycsXG4gIF0sXG4gIHJlc291cmNlczogWycqJ10sIFxufSkpO1xuXG5jb25zdCBmbHVlbnRCaXRNYW5pZmVzdHNEaXIgPSBwYXRoLmpvaW4oX19kaXJuYW1lLCAnLi4vbWFuaWZlc3RzL2ZsdWVudC1iaXQnKTtcbmNvbnN0IGZsdWVudEJpdEZpbGVzID0gWyduYW1lc3BhY2UtY2xvdWR3YXRjaC55YW1sJywgJ3NlcnZpY2UtYWNjb3VudC55YW1sJywgJ2NvbmZpZ21hcC55YW1sJywgJ2RhZW1vbi1zZXQueWFtbCddO1xuXG5jb25zdCBsb2FkWWFtbE1hbmlmZXN0ID0gKGZpbGVOYW1lOiBzdHJpbmcpID0+XG4gIHlhbWwucGFyc2VBbGxEb2N1bWVudHMoZnMucmVhZEZpbGVTeW5jKHBhdGguam9pbihmbHVlbnRCaXRNYW5pZmVzdHNEaXIsIGZpbGVOYW1lKSwgJ3V0ZjgnKSlcbiAgICAubWFwKGRvYyA9PiBkb2MudG9KU09OKCkpXG4gICAgLmZpbHRlcihCb29sZWFuKTtcblxuY29uc3QgbmFtZXNwYWNlTWFuaWZlc3QgPSBsb2FkWWFtbE1hbmlmZXN0KCduYW1lc3BhY2UtY2xvdWR3YXRjaC55YW1sJyk7XG5cbmNvbnN0IGZsdWVudEJpdE90aGVyUmVzb3VyY2VzID0gZmx1ZW50Qml0RmlsZXNcbiAgLmZpbHRlcihmID0+IGYgIT09ICduYW1lc3BhY2UtY2xvdWR3YXRjaC55YW1sJykgLy8g4p2XIEltcG9ydGFudCBmaXhcbiAgLmZsYXRNYXAoZmlsZSA9PiB7XG4gICAgaWYgKGZpbGUgPT09ICdzZXJ2aWNlLWFjY291bnQueWFtbCcpIHtcbiAgICAgIGNvbnN0IHNhQ29udGVudCA9IGZzLnJlYWRGaWxlU3luYyhwYXRoLmpvaW4oZmx1ZW50Qml0TWFuaWZlc3RzRGlyLCBmaWxlKSwgJ3V0ZjgnKVxuICAgICAgICAucmVwbGFjZSgnPElSU0FfUk9MRV9BUk5fUExBQ0VIT0xERVI+JywgZmx1ZW50Qml0U0Eucm9sZS5yb2xlQXJuKTtcbiAgICAgIHJldHVybiB5YW1sLnBhcnNlQWxsRG9jdW1lbnRzKHNhQ29udGVudCkubWFwKGRvYyA9PiBkb2MudG9KU09OKCkpLmZpbHRlcihCb29sZWFuKTtcbiAgICB9XG4gICAgcmV0dXJuIGxvYWRZYW1sTWFuaWZlc3QoZmlsZSk7XG4gIH0pO1xuXG4gICAgICBjb25zdCBmbHVlbnRCaXROcyA9IGNsdXN0ZXIuYWRkTWFuaWZlc3QoJ0ZsdWVudEJpdE5hbWVzcGFjZScsIC4uLm5hbWVzcGFjZU1hbmlmZXN0KTtcbiAgICAgIGNvbnN0IGZsdWVudEJpdFJlc291cmNlcyA9IGNsdXN0ZXIuYWRkTWFuaWZlc3QoJ0ZsdWVudEJpdFJlc291cmNlcycsIC4uLmZsdWVudEJpdE90aGVyUmVzb3VyY2VzKTtcbiAgICAgIGZsdWVudEJpdFJlc291cmNlcy5ub2RlLmFkZERlcGVuZGVuY3koZmx1ZW50Qml0TnMpO1xuXG4gICAgICBjb25zdCBtYW5pZmVzdHNEaXIgPSBwYXRoLmpvaW4oX19kaXJuYW1lLCAnLi4vbWFuaWZlc3RzJyk7XG4gICAgICBjb25zdCBmaWxlcyA9WyduYW1lc3BhY2UueWFtbCcsJ3JvbGViaW5kaW5nLnlhbWwnLCdjb25maWdNYXAtc2VjcmV0LnlhbWwnLCdkZXBsb3ltZW50LnlhbWwnLCAnSFBBLnlhbWwnLCAnam9iLnlhbWwnXTtcblxuIGZvciAoY29uc3QgZW52TmFtZSBvZiBPYmplY3Qua2V5cyhlbnZjb25maWdzKSkge1xuICAgICAgY29uc3QgY29uZmlnID0gZW52Y29uZmlnc1tlbnZOYW1lXTtcblxuICAgICAgY29uc3QgcGxhY2Vob2xkZXJzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuICAgICAgICAne3tFTlZ9fSc6IGVudk5hbWUsXG4gICAgICAgICd7e0FQUF9WRVJTSU9OfX0nOiBjb25maWcuYXBwVmVyc2lvbiB8fCAnMS4wLjAnLFxuICAgICAgICAne3tSRVBMSUNBX0NPVU5UfX0nOiAoY29uZmlnLnJlcGxpY2FDb3VudCB8fCAxKS50b1N0cmluZygpLFxuICAgICAgICAne3tSRVFVRVNUX0NQVX19JzogY29uZmlnLnJlcXVlc3RDcHUgfHwgJzEwMG0nLFxuICAgICAgICAne3tMSU1JVF9DUFV9fSc6IGNvbmZpZy5saW1pdENwdSB8fCAnMjAwbScsXG4gICAgICAgICd7e0ZFQVRVUkVfRkxBR319JzogY29uZmlnLmZlYXR1cmVGbGFnID09PSB1bmRlZmluZWQgPyAnZmFsc2UnIDogY29uZmlnLmZlYXR1cmVGbGFnLnRvU3RyaW5nKCksXG4gICAgICB9O1xuICAgIFxuICAgICAgY29uc3QgcmVwbGFjZVBsYWNlaG9sZGVycyA9IChjb250ZW50OiBzdHJpbmcpID0+IHtcbiAgICAgICAgZm9yIChjb25zdCBba2V5LCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXMocGxhY2Vob2xkZXJzKSkge1xuICAgICAgICAgIGNvbnRlbnQgPSBjb250ZW50LnJlcGxhY2UobmV3IFJlZ0V4cChrZXksICdnJyksIHZhbHVlKTtcbiAgICAgICAgfVxuICAgICAgICAgIHJldHVybiBjb250ZW50O1xuICAgICAgIH07XG5cbiAgICAgIGNvbnN0IGFsbFJlc291cmNlcyA9IGZpbGVzLmZsYXRNYXAoKGZpbGUpID0+IHtcbiAgICAgICAgY29uc3QgY29udGVudCA9IHJlcGxhY2VQbGFjZWhvbGRlcnMoZnMucmVhZEZpbGVTeW5jKHBhdGguam9pbihtYW5pZmVzdHNEaXIsIGZpbGUpLCAndXRmOCcpXG4gICAgICAgICk7XG4gICAgICAgIHJldHVybiB5YW1sLnBhcnNlQWxsRG9jdW1lbnRzKGNvbnRlbnQpLm1hcCgoZG9jKSA9PiBkb2MudG9KU09OKCkpLmZpbHRlcihCb29sZWFuKTtcbiAgICAgIH0pO1xuXG4gICAgICBjb25zdCBuYW1lc3BhY2VSZXNvdXJjZXMgPSBhbGxSZXNvdXJjZXMuZmlsdGVyKChyZXMpID0+IHJlcy5raW5kID09PSAnTmFtZXNwYWNlJyk7XG4gICAgICBjb25zdCBvdGhlclJlc291cmNlcyA9IGFsbFJlc291cmNlcy5maWx0ZXIoKHJlcykgPT4gcmVzLmtpbmQgIT09ICdOYW1lc3BhY2UnKTtcblxuICAgICAgY29uc3QgbmFtZXNwYWNlTWFuaWZlc3QgPSBjbHVzdGVyLmFkZE1hbmlmZXN0KGBOYW1lc3BhY2VNYW5pZmVzdC0ke2Vudk5hbWV9YCwuLi5uYW1lc3BhY2VSZXNvdXJjZXMpO1xuICAgICAgY29uc3QgYXBwTWFuaWZlc3QgPSBjbHVzdGVyLmFkZE1hbmlmZXN0KGBBcHBNYW5pZmVzdHMtJHtlbnZOYW1lfWAsLi4ub3RoZXJSZXNvdXJjZXMpO1xuXG4gICAgICBhcHBNYW5pZmVzdC5ub2RlLmFkZERlcGVuZGVuY3kobmFtZXNwYWNlTWFuaWZlc3QpO1xuICAgIH1cbiAgfX1cbiJdfQ==