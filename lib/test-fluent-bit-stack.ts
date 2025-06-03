import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as fs from 'fs';
import * as yaml from 'yaml';
import * as path from 'path';
import { KubectlV28Layer } from '@aws-cdk/lambda-layer-kubectl-v28';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

export class DeployingMicoserviceOnEksStack extends cdk.Stack{
  constructor(scope:Construct, id:string, props?:cdk.StackProps) {super(scope,id,props);

    const envconfigs = this.node.tryGetContext('envconfigs');

    const iamroleforcluster = new iam.Role(this, 'EksAdminRole', {
      assumedBy: new iam.AccountRootPrincipal(),
    });

   const vpc=new ec2.Vpc(this,'vpc',{
      natGateways: 1,
      subnetConfiguration: [
        {name: 'PrivateSubnet', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24,},
        {name: 'PublicSubnet', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24,},
      ],
    });

    const cluster=new eks.Cluster(this, 'EksCluster', 
        {clusterName: 'EksCluster',
          defaultCapacity:0,
          vpc,
          version: eks.KubernetesVersion.V1_28,
          kubectlLayer: new KubectlV28Layer(this, 'kubectl'),
          vpcSubnets:[{subnetType:ec2.SubnetType.PRIVATE_WITH_EGRESS}],
          mastersRole:iamroleforcluster,
           })
            
        const nodegroup=cluster.addNodegroupCapacity('NodeGroup',{
        desiredSize:2,
        instanceTypes: [new ec2.InstanceType('t3.medium')],
        remoteAccess: { sshKeyName: 'demo',
        },
      });

      nodegroup.role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName
        ('AmazonSSMManagedInstanceCore'));
      
      cluster.awsAuth.addRoleMapping(nodegroup.role, {
        username: 'system:node:{{EC2PrivateDNSName}}',
        groups: ['system:bootstrappers', 'system:nodes', 'system:masters'],
     });

      cluster.addHelmChart('MetricsServer', {
        chart: 'metrics-server',
        repository: 'https://kubernetes-sigs.github.io/metrics-server/',
        release: 'metrics-server',
        namespace: 'kube-system',
        values: {args: [
        '--kubelet-insecure-tls',
        '--kubelet-preferred-address-types=InternalIP,Hostname,ExternalIP',],},
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

    const loadYamlManifest = (fileName: string) =>
      yaml.parseAllDocuments(fs.readFileSync(path.join(fluentBitManifestsDir, fileName), 'utf8'))
        .map(doc => doc.toJSON())
        .filter(Boolean);

    const namespaceManifest = loadYamlManifest('namespace.yaml');
    const fluentBitOtherResources = fluentBitFiles
      .filter(f => f !== 'namespace.yaml')
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

      const manifestsDir='manifests';
      const files =['namespace.yaml','rolebinding.yaml','configMap-secret.yaml','deployment.yaml', 'HPA.yaml', 'job.yaml'];

 for (const envName of Object.keys(envconfigs)) {
      const config = envconfigs[envName];

      const placeholders: Record<string, string> = {
        '{{ENV}}': envName,
        '{{APP_VERSION}}': config.appVersion || '1.0.0',
        '{{REPLICA_COUNT}}': (config.replicaCount || 1).toString(),
        '{{REQUEST_CPU}}': config.requestCpu || '100m',
        '{{LIMIT_CPU}}': config.limitCpu || '200m',
        '{{FEATURE_FLAG}}': config.featureFlag === undefined ? 'false' : config.featureFlag.toString(),
      };
    
      const replacePlaceholders = (content: string) => {
        for (const [key, value] of Object.entries(placeholders)) {
          content = content.replace(new RegExp(key, 'g'), value);
        }
          return content;
       };

      const allResources = files.flatMap((file) => {
        const content = replacePlaceholders(fs.readFileSync(path.join(manifestsDir, file), 'utf8')
        );
        return yaml.parseAllDocuments(content).map((doc) => doc.toJSON()).filter(Boolean);
      });

      const namespaceResources = allResources.filter((res) => res.kind === 'Namespace');
      const otherResources = allResources.filter((res) => res.kind !== 'Namespace');

      const namespaceManifest = cluster.addManifest(`NamespaceManifest-${envName}`,...namespaceResources);
      const appManifest = cluster.addManifest(`AppManifests-${envName}`,...otherResources);

      appManifest.node.addDependency(namespaceManifest);
    }
  }}
