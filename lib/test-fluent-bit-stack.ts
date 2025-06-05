import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as fs from 'fs';
import * as yaml from 'yaml';
import * as path from 'path';
import { KubectlV28Layer } from '@aws-cdk/lambda-layer-kubectl-v28';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
 
export class DeployingMicroserviceOnEksStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
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
      kubectlLayer: new KubectlV28Layer(this, 'kubectl'),
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
    const cloudwatchNamespace = cluster.addManifest('CloudWatchNamespace', ...yaml.parseAllDocuments(
      fs.readFileSync(namespaceManifestPath, 'utf8')
    ).map(doc => doc.toJSON()).filter(Boolean));
 
    const conditionJson = new cdk.CfnJson(this, 'OIDCCondition', {
      value: {
        [`${cluster.openIdConnectProvider.openIdConnectProviderIssuer}:sub`]:
          'system:serviceaccount:amazon-cloudwatch:fluent-bit',
      },
    });
 
    const fluentBitSaRole = new iam.Role(this, 'FluentBitIRSA', {
      assumedBy: new iam.WebIdentityPrincipal(
        cluster.openIdConnectProvider.openIdConnectProviderArn,
        { StringEquals: conditionJson }
      ),
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
 
      const placeholders: Record<string, string> = {
        '{{ENV}}': envName,
        '{{APP_VERSION}}': config.appVersion || '1.0.0',
        '{{REPLICA_COUNT}}': (config.replicaCount || 1).toString(),
        '{{REQUEST_CPU}}': config.requestCpu || '100m',
        '{{LIMIT_CPU}}': config.limitCpu || '200m',
        '{{FEATURE_FLAG}}': config.featureFlag === undefined ? 'false' : config.featureFlag.toString(),
        '{{LOG_GROUP_NAME}}': `/eks/${envName}/app-logs`,
      };
 
      const replacePlaceholders = (content: string) => {
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
      if (a.kind === 'Namespace') return -1;
      if (b.kind === 'Namespace') return 1;
      return 0;
    });
 
    const mergedManifest = cluster.addManifest('AllAppManifests', ...sortedAllResources);
    mergedManifest.node.addDependency(cloudwatchNamespace);
  }
}