import { NativeConnection, Worker } from '@temporalio/worker';

async function run() {
  const address = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
  const namespace = process.env.TEMPORAL_NAMESPACE ?? 'default';

  const connection = await NativeConnection.connect({ address });
  const worker = await Worker.create({
    connection,
    namespace,
    taskQueue: 'acdt-task-queue',
    workflowsPath: require.resolve('./workflows'),
    activities: await import('./activities')
  });

  console.log(`Temporal worker started on ${address} (namespace: ${namespace})`);
  await worker.run();
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
