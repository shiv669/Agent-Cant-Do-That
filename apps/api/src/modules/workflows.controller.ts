import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { StartOffboardingInput } from '@contracts/index';
import { WorkflowsService } from './workflows.service';

@Controller('workflows')
export class WorkflowsController {
  constructor(private readonly workflowsService: WorkflowsService) {}

  @Post('offboarding/start')
  async startOffboarding(
    @Body() body: StartOffboardingInput & { opsSubjectToken?: string },
    @Req() req: { headers: Record<string, string | string[] | undefined> }
  ) {
    const authHeader = req.headers.authorization;
    const headerValue = Array.isArray(authHeader) ? authHeader[0] : authHeader;
    const tokenFromHeader = headerValue?.startsWith('Bearer ') ? headerValue.slice('Bearer '.length).trim() : undefined;

    return this.workflowsService.startOffboarding({
      ...body,
      opsSubjectToken: body.opsSubjectToken ?? tokenFromHeader
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
