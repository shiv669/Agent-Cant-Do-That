import { Injectable } from '@nestjs/common';

export type SupportedAction =
  | 'revoke_access'
  | 'export_billing_history'
  | 'cancel_subscriptions'
  | 'validate_customer_state'
  | 'enumerate_data_stores'
  | 'run_compliance_check'
  | 'execute_refund'
  | 'execute_data_deletion';

export type AgentDecision = {
  action: SupportedAction;
  actionReason: string;
  reasoning: string;
  decisionSource: 'llm' | 'rules';
  modelProvider: string;
  modelName: string;
};

type PlanInput = {
  workflowId: string;
  customerId: string;
  completedActions: string[];
  amountUsd?: number;
};

const SUPPORTED_ACTIONS: SupportedAction[] = [
  'revoke_access',
  'export_billing_history',
  'cancel_subscriptions',
  'validate_customer_state',
  'enumerate_data_stores',
  'run_compliance_check',
  'execute_refund',
  'execute_data_deletion'
];

const LOW_RISK_SEQUENCE: SupportedAction[] = [
  'revoke_access',
  'export_billing_history',
  'cancel_subscriptions',
  'validate_customer_state',
  'enumerate_data_stores',
  'run_compliance_check',
  'execute_refund',
  'execute_data_deletion'
];

@Injectable()
export class AgentRuntimeService {
  private readonly groqApiKey = process.env.GROQ_API_KEY?.trim();
  private readonly modelProvider = (process.env.AGENT_MODEL_PROVIDER ?? 'groq').trim().toLowerCase();
  private readonly groqModel = process.env.AGENT_MODEL_NAME?.trim() || 'llama-3.1-8b-instant';

  async planAction(input: PlanInput): Promise<AgentDecision> {
    if (this.modelProvider === 'groq' && this.groqApiKey) {
      const llmDecision = await this.planViaGroq(input);
      if (llmDecision) {
        return llmDecision;
      }
    }

    return this.planViaRules(input);
  }

  private async planViaGroq(input: PlanInput): Promise<AgentDecision | null> {
    const systemPrompt = [
      'You are an autonomous enterprise operations agent.',
      'Return JSON only.',
      'Do not include markdown code fences.',
      'Choose the next logical offboarding step from the supported action list.',
      'Never invent new actions.',
      'The system enforces policy externally. Provide an auditable reason for the selected next action.',
      'JSON schema: {"next_action":"SupportedAction","reasoning":"string"}'
    ].join(' ');

    const userPrompt = JSON.stringify({
      workflowId: input.workflowId,
      customerId: input.customerId,
      completedActions: input.completedActions,
      supportedActions: SUPPORTED_ACTIONS,
      amountUsd: input.amountUsd ?? null,
      instruction:
        'Select exactly one next_action from supportedActions to safely progress offboarding given completedActions.'
    });

    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.groqApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: this.groqModel,
          temperature: 0.2,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ]
        })
      });

      if (!response.ok) {
        return null;
      }

      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };

      const content = payload.choices?.[0]?.message?.content;
      if (!content) {
        return null;
      }

      const parsed = JSON.parse(content) as { next_action?: string; reasoning?: string };
      const suggestedAction = parsed.next_action as SupportedAction;
      const action = SUPPORTED_ACTIONS.includes(suggestedAction) ? suggestedAction : this.nextFromRules(input);

      return {
        action,
        actionReason: this.defaultReason(action, input.amountUsd),
        reasoning: this.normalizeText(parsed.reasoning, this.defaultReasoning(action, input.customerId)),
        decisionSource: 'llm',
        modelProvider: 'groq',
        modelName: this.groqModel
      };
    } catch {
      return null;
    }
  }

  private planViaRules(input: PlanInput): AgentDecision {
    const action = this.nextFromRules(input);

    return {
      action,
      actionReason: this.defaultReason(action, input.amountUsd),
      reasoning: this.defaultReasoning(action, input.customerId),
      decisionSource: 'rules',
      modelProvider: 'rules',
      modelName: 'deterministic-policy'
    };
  }

  private nextFromRules(input: PlanInput): SupportedAction {
    const done = new Set(input.completedActions);
    for (const action of LOW_RISK_SEQUENCE) {
      if (!done.has(action)) {
        return action;
      }
    }

    return 'execute_data_deletion';
  }

  private normalizeText(value: unknown, fallback: string): string {
    if (typeof value !== 'string') {
      return fallback;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : fallback;
  }

  private defaultReason(action: SupportedAction, amountUsd?: number): string {
    switch (action) {
      case 'revoke_access':
        return 'Access revocation is required to prevent post-termination account activity.';
      case 'export_billing_history':
        return 'Billing records must be exported for reconciliation and legal retention before deprovisioning.';
      case 'cancel_subscriptions':
        return 'Active subscriptions must be cancelled to stop future charges.';
      case 'validate_customer_state':
        return 'Customer state validation confirms account is eligible for irreversible offboarding.';
      case 'enumerate_data_stores':
        return 'Data store enumeration is required to build a complete deletion scope.';
      case 'run_compliance_check':
        return 'Compliance check ensures no legal hold or retention constraints block execution.';
      case 'execute_refund':
        return `Refund execution requested for financial closure${typeof amountUsd === 'number' ? ` (amount: ${amountUsd.toFixed(2)} USD)` : ''}.`;
      case 'execute_data_deletion':
        return 'Data deletion execution is required to complete customer offboarding obligations.';
      default:
        return 'Action selected by deterministic offboarding policy.';
    }
  }

  private defaultReasoning(action: SupportedAction, customerId?: string): string {
    const customer = customerId?.trim() || 'unknown_customer';
    switch (action) {
      case 'execute_refund':
        return `Workflow policy for ${customer} reached a high-risk financial step. Attempt execution and rely on authority controls to enforce scope.`;
      case 'execute_data_deletion':
        return `Workflow policy for ${customer} reached a high-risk deletion step. A separate authority window is required; prior refund approval cannot carry over.`;
      default:
        return `Workflow policy for ${customer} indicates this low-risk step should run now to advance offboarding.`;
    }
  }
}
