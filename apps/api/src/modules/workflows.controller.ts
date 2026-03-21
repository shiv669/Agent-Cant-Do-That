import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import type { StartOffboardingInput } from '@contracts/index';
import { WorkflowsService } from './workflows.service';

@Controller('workflows')
export class WorkflowsController {
  constructor(private readonly workflowsService: WorkflowsService) {}

  @Post('offboarding/start')
  async startOffboarding(@Body() body: StartOffboardingInput) {
    return this.workflowsService.startOffboarding(body);
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
