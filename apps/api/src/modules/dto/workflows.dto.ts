import { Transform, Type } from 'class-transformer';
import { IsArray, IsBoolean, IsEnum, IsNumber, IsOptional, IsString } from 'class-validator';
import type { SupportedAction } from '../agent-runtime.service';

export class StartOffboardingBodyDto {
  @IsString()
  customerId!: string;

  @Type(() => Number)
  @IsNumber()
  refundAmountUsd!: number;

  @IsOptional()
  @IsString()
  opsSubjectToken?: string;

  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  demoMode?: boolean;
}

export class WorkflowIdParamDto {
  @IsString()
  workflowId!: string;
}

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

export enum SupportedActionDto {
  RevokeAccess = 'revoke_access',
  ExportBillingHistory = 'export_billing_history',
  CancelSubscriptions = 'cancel_subscriptions',
  ValidateCustomerState = 'validate_customer_state',
  EnumerateDataStores = 'enumerate_data_stores',
  RunComplianceCheck = 'run_compliance_check',
  ExecuteRefund = 'execute_refund',
  ExecuteDataDeletion = 'execute_data_deletion'
}

export class InternalPlanNextBodyDto {
  @IsString()
  workflowId!: string;

  @IsString()
  customerId!: string;

  @Type(() => Number)
  @IsNumber()
  refundAmountUsd!: number;
}

export class InternalExecuteStepBodyDto extends InternalPlanNextBodyDto {
  @IsEnum(SupportedActionDto)
  action!: SupportedActionDto;

  @IsOptional()
  @IsString()
  opsSubjectToken?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  completedActions?: string[];
}

export function toSupportedAction(value: SupportedActionDto): SupportedAction {
  const action = value as SupportedAction;
  if (!SUPPORTED_ACTIONS.includes(action)) {
    throw new Error('Unsupported action');
  }
  return action;
}
