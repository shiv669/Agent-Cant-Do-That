import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { WorkflowsController } from './workflows.controller';
import { WorkflowsService } from './workflows.service';

@Module({
  imports: [],
  controllers: [HealthController, WorkflowsController],
  providers: [WorkflowsService]
})
export class AppModule {}
