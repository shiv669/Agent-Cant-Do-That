import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { StartOffboardingInput } from '@contracts/index';
import { WorkflowsService } from './workflows.service';
import { DemoTokenService } from './demo-token.service';

@Controller('workflows')
export class WorkflowsController {
  constructor(
    private readonly workflowsService: WorkflowsService,
    private readonly demoTokenService: DemoTokenService
  ) {}

  @Post('offboarding/start')
  async startOffboarding(
    @Body() body: StartOffboardingInput & { opsSubjectToken?: string; demoMode?: boolean },
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

  @Get(':workflowId/status')
  async getStatus(@Param('workflowId') workflowId: string) {
    return this.workflowsService.getStatus(workflowId);
  }

  @Get(':workflowId/ledger')
  async getLedger(@Param('workflowId') workflowId: string) {
    return this.workflowsService.getLedger(workflowId);
  }
}
