import { proxyActivities } from '@temporalio/workflow';

type SupportedAction =
  | 'revoke_access'
  | 'export_billing_history'
  | 'cancel_subscriptions'
  | 'validate_customer_state'
  | 'enumerate_data_stores'
  | 'run_compliance_check'
  | 'execute_refund'
  | 'execute_data_deletion';

type WorkflowInput = {
  workflowId: string;
  customerId: string;
  refundAmountUsd: number;
  opsSubjectToken?: string;
};

type Activities = {
  planNextAction(input: {
    workflowId: string;
    customerId: string;
    refundAmountUsd: number;
  }): Promise<{
    nextAction: SupportedAction;
    reasoning: string;
    actionReason: string;
    completedActions: string[];
  }>;
  executeActionStep(input: {
    workflowId: string;
    customerId: string;
    action: SupportedAction;
    refundAmountUsd: number;
    opsSubjectToken?: string;
    completedActions?: string[];
  }): Promise<{
    action: SupportedAction;
    blocked: boolean;
    completed: boolean;
  }>;
};

const { planNextAction, executeActionStep } = proxyActivities<Activities>({
  startToCloseTimeout: '2 minutes',
  retry: {
    maximumAttempts: 3
  }
});

export async function customerOffboardingWorkflow(input: WorkflowInput) {
  let loopCount = 0;
  while (loopCount < 20) {
    loopCount += 1;

    const plan = await planNextAction({
      workflowId: input.workflowId,
      customerId: input.customerId,
      refundAmountUsd: input.refundAmountUsd
    });

    const execution = await executeActionStep({
      workflowId: input.workflowId,
      customerId: input.customerId,
      action: plan.nextAction,
      refundAmountUsd: input.refundAmountUsd,
      opsSubjectToken: input.opsSubjectToken,
      completedActions: plan.completedActions
    });

    if (execution.blocked) {
      return {
        status: 'blocked-awaiting-authority',
        workflowId: input.workflowId,
        blockedAction: execution.action,
        loopCount
      };
    }

    if (execution.action === 'execute_data_deletion' && execution.completed) {
      return {
        status: 'completed',
        workflowId: input.workflowId,
        loopCount
      };
    }
  }

  return {
    status: 'failed',
    workflowId: input.workflowId,
    reason: 'Workflow step loop exhausted without terminal state'
  };
}
