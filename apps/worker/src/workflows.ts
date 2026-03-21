import { proxyActivities } from '@temporalio/workflow';

type Activities = {
  logStep(message: string): Promise<void>;
};

const { logStep } = proxyActivities<Activities>({
  startToCloseTimeout: '1 minute'
});

export async function customerOffboardingWorkflow(input: { customerId: string }) {
  await logStep(`Starting offboarding workflow for ${input.customerId}`);
  await logStep('Low-risk actions completed');
  await logStep('High-risk action requires authority window (placeholder)');

  return {
    status: 'blocked-awaiting-authority',
    customerId: input.customerId
  };
}
