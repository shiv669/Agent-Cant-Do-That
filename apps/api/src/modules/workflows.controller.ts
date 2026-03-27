import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { StartOffboardingInput } from '@contracts/index';
import { WorkflowsService } from './workflows.service';
import { DemoTokenService } from './demo-token.service';
import {
  InternalExecuteStepBodyDto,
  InternalPlanNextBodyDto,
  StartOffboardingBodyDto,
  WorkflowIdParamDto,
  toSupportedAction
} from './dto/workflows.dto';

@Controller('workflows')
export class WorkflowsController {
  constructor(
    private readonly workflowsService: WorkflowsService,
    private readonly demoTokenService: DemoTokenService
  ) {}

  @Post('offboarding/start')
  async startOffboarding(
    @Body() body: StartOffboardingBodyDto,
    @Req() req: { headers: Record<string, string | string[] | undefined> }
  ) {
    const authHeader = req.headers.authorization;
    const headerValue = Array.isArray(authHeader) ? authHeader[0] : authHeader;
    const tokenFromHeader = headerValue?.startsWith('Bearer ') ? headerValue.slice('Bearer '.length).trim() : undefined;

    const demoOpsToken = body.demoMode ? await this.demoTokenService.getRequiredToken('ops-manager') : undefined;

    return this.workflowsService.startOffboarding({
      ...body,
      opsSubjectToken: demoOpsToken ?? body.opsSubjectToken ?? tokenFromHeader
    } as StartOffboardingInput);
  }

  @Post('internal/plan-next')
  async planNext(@Body() body: InternalPlanNextBodyDto) {
    return this.workflowsService.planNextAction(body);
  }

  @Post('internal/execute-step')
  async executeStep(@Body() body: InternalExecuteStepBodyDto) {
    return this.workflowsService.executeActionStep({
      ...body,
      action: toSupportedAction(body.action)
    });
  }

  @Get(':workflowId/status')
  async getStatus(@Param() params: WorkflowIdParamDto) {
    return this.workflowsService.getStatus(params.workflowId);
  }

  @Get(':workflowId/ledger')
  async getLedger(@Param() params: WorkflowIdParamDto) {
    return this.workflowsService.getLedger(params.workflowId);
  }
}
