import { Injectable } from '@nestjs/common';
import { Client, Connection } from '@temporalio/client';
import { LedgerRepository } from './ledger.repository';
import type {
  LedgerEvent,
  StartOffboardingInput,
  StartOffboardingResponse,
  WorkflowStatusResponse
} from '@contracts/index';
import type { OnModuleInit } from '@nestjs/common';

@Injectable()
export class WorkflowsService implements OnModuleInit {
  constructor(private readonly ledgerRepository: LedgerRepository) {}

  async onModuleInit(): Promise<void> {
    await this.ledgerRepository.ensureSchema();
  }

  private async getTemporalClient(): Promise<Client> {
    const address = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
    const namespace = process.env.TEMPORAL_NAMESPACE ?? 'default';

    const connection = await Connection.connect({ address });
    return new Client({ connection, namespace });
  }

  private async appendEvent(workflowId: string, eventType: LedgerEvent['eventType'], payload: Record<string, unknown>) {
    await this.ledgerRepository.appendEvent({
      workflowId,
      eventType,
      payload
    });
  }

  async startOffboarding(input: StartOffboardingInput): Promise<StartOffboardingResponse> {
    const workflowId = `offboarding-${input.customerId}-${Date.now()}`;

    const client = await this.getTemporalClient();

    await client.workflow.start('customerOffboardingWorkflow', {
      taskQueue: 'acdt-task-queue',
      workflowId,
      args: [input]
    });

    await this.appendEvent(workflowId, 'authorization_blocked', {
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
    return this.ledgerRepository.listByWorkflowId(workflowId);
  }
}
