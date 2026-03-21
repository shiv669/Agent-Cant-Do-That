import { Injectable } from '@nestjs/common';
import { Client, Connection } from '@temporalio/client';
import type {
  LedgerEvent,
  StartOffboardingInput,
  StartOffboardingResponse,
  WorkflowStatusResponse
} from '@contracts/index';

@Injectable()
export class WorkflowsService {
  private readonly eventsByWorkflowId = new Map<string, LedgerEvent[]>();
  private nextSeqId = 1;

  private async getTemporalClient(): Promise<Client> {
    const address = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
    const namespace = process.env.TEMPORAL_NAMESPACE ?? 'default';

    const connection = await Connection.connect({ address });
    return new Client({ connection, namespace });
  }

  private appendEvent(workflowId: string, eventType: LedgerEvent['eventType'], payload: Record<string, unknown>) {
    const event: LedgerEvent = {
      seqId: this.nextSeqId++,
      workflowId,
      eventType,
      createdAt: new Date().toISOString(),
      payload
    };

    const current = this.eventsByWorkflowId.get(workflowId) ?? [];
    current.push(event);
    this.eventsByWorkflowId.set(workflowId, current);
  }

  async startOffboarding(input: StartOffboardingInput): Promise<StartOffboardingResponse> {
    const workflowId = `offboarding-${input.customerId}-${Date.now()}`;

    const client = await this.getTemporalClient();

    await client.workflow.start('customerOffboardingWorkflow', {
      taskQueue: 'acdt-task-queue',
      workflowId,
      args: [input]
    });

    this.appendEvent(workflowId, 'authorization_blocked', {
      reason: 'Initial high-risk placeholder state from workflow scaffold',
      actionScope: 'execute:refund'
    });

    return {
      workflowId,
      customerId: input.customerId,
      status: 'blocked-awaiting-authority'
    };
  }

  async getStatus(workflowId: string): Promise<WorkflowStatusResponse> {
    return {
      workflowId,
      status: 'blocked-awaiting-authority'
    };
  }

  async getLedger(workflowId: string): Promise<LedgerEvent[]> {
    return this.eventsByWorkflowId.get(workflowId) ?? [];
  }
}
