import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  Max,
  IsUUID
} from 'class-validator';

export enum HighRiskActionScopeDto {
  ExecuteRefund = 'execute:refund',
  ExecuteDataDeletion = 'execute:data_deletion'
}

export class HighRiskCheckBodyDto {
  @IsString()
  workflowId!: string;

  @IsEnum(HighRiskActionScopeDto)
  actionScope!: HighRiskActionScopeDto;

  @IsOptional()
  @IsString()
  authorityWindowToken?: string;

  @IsOptional()
  @IsString()
  actionReason?: string;

  @IsOptional()
  @IsString()
  reasoning?: string;

  @IsOptional()
  @IsString()
  decisionSource?: string;

  @IsOptional()
  @IsString()
  modelProvider?: string;

  @IsOptional()
  @IsString()
  modelName?: string;
}

export class EscalationAttemptBodyDto extends HighRiskCheckBodyDto {
  @IsOptional()
  @IsString()
  reason?: string;
}

export class AuthorityWindowRequestBodyDto {
  @IsString()
  workflowId!: string;

  @IsString()
  customerId!: string;

  @IsOptional()
  @IsEnum(HighRiskActionScopeDto)
  scope?: HighRiskActionScopeDto;

  @IsEnum(HighRiskActionScopeDto)
  actionScope!: HighRiskActionScopeDto;

  @IsOptional()
  @IsString()
  agentId?: string;

  @IsOptional()
  @IsString()
  boundAgentClientId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  amount?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(30)
  @Max(300)
  ttlSeconds?: number;

  @IsOptional()
  @IsString()
  actionReason?: string;

  @IsOptional()
  @IsString()
  reasoning?: string;

  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  demoMode?: boolean;
}

export class AuthorityWindowClaimBodyDto {
  @IsUUID()
  windowId!: string;

  @IsOptional()
  @IsString()
  agentId?: string;
}

export class AuthorityWindowConsumeBodyDto extends AuthorityWindowClaimBodyDto {
  @IsOptional()
  @IsString()
  actionReason?: string;

  @IsOptional()
  @IsString()
  reasoning?: string;
}

export class AuthorityWindowReplayBodyDto extends AuthorityWindowClaimBodyDto {}

export class WindowIdParamDto {
  @IsUUID()
  windowId!: string;
}

export class WorkflowIdParamDto {
  @IsString()
  workflowId!: string;
}

export class LedgerStreamQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sinceSeqId?: number;
}
