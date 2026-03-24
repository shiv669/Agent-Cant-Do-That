import { Module } from '@nestjs/common';
import { AuthorityController } from './authority.controller';
import { AuthorityService } from './authority.service';
import { Auth0AuthorityService } from './auth0-authority.service';
import { AgentRuntimeService } from './agent-runtime.service';
import { AuthorityWindowRepository } from './authority-window.repository';
import { HealthController } from './health.controller';
import { WorkflowsController } from './workflows.controller';
import { WorkflowsService } from './workflows.service';
import { LedgerRepository } from './ledger.repository';
import { EvidenceSheetService } from './evidence-sheet.service';

@Module({
  imports: [],
  controllers: [HealthController, WorkflowsController, AuthorityController],
  providers: [
    WorkflowsService,
    LedgerRepository,
    AuthorityService,
    Auth0AuthorityService,
    AuthorityWindowRepository,
    AgentRuntimeService,
    EvidenceSheetService
  ]
})
export class AppModule {}
