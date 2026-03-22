import { Module } from '@nestjs/common';
import { AuthorityController } from './authority.controller';
import { AuthorityService } from './authority.service';
import { Auth0AuthorityService } from './auth0-authority.service';
import { AuthorityWindowRepository } from './authority-window.repository';
import { HealthController } from './health.controller';
import { WorkflowsController } from './workflows.controller';
import { WorkflowsService } from './workflows.service';
import { LedgerRepository } from './ledger.repository';

@Module({
  imports: [],
  controllers: [HealthController, WorkflowsController, AuthorityController],
  providers: [WorkflowsService, LedgerRepository, AuthorityService, Auth0AuthorityService, AuthorityWindowRepository]
})
export class AppModule {}
