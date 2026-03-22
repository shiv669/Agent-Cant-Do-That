import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { WorkflowsController } from './workflows.controller';
import { WorkflowsService } from './workflows.service';
import { LedgerRepository } from './ledger.repository';

@Module({
  imports: [],
  controllers: [HealthController, WorkflowsController],
  providers: [WorkflowsService, LedgerRepository]
})
export class AppModule {}
