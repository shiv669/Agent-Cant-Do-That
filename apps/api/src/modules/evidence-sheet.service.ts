import { Injectable } from '@nestjs/common';
import type { LedgerEvent } from '@contracts/index';

type SheetContext = {
  spreadsheetId: string;
  accessToken: string;
};

@Injectable()
export class EvidenceSheetService {
  private readonly contexts = new Map<string, SheetContext>();

  async registerWorkflowSheet(input: { workflowId: string; spreadsheetId: string; accessToken: string }): Promise<void> {
    this.contexts.set(input.workflowId, {
      spreadsheetId: input.spreadsheetId,
      accessToken: input.accessToken
    });

    const headerRows = [
      ['event_received_at', 'seq_id', 'event_type', 'actor', 'action_scope', 'action_reason', 'reasoning']
    ];

    await this.appendRows(input.spreadsheetId, input.accessToken, 'LiveFeed!A1', headerRows).catch(() => undefined);
  }

  async appendLedgerEvent(event: LedgerEvent): Promise<void> {
    const context = this.contexts.get(event.workflowId);
    if (!context) {
      return;
    }

    const payload = typeof event.payload === 'object' && event.payload !== null
      ? (event.payload as Record<string, unknown>)
      : {};

    const actor = typeof payload.actor === 'string' ? payload.actor : 'system';
    const actionScope = typeof payload.actionScope === 'string' ? payload.actionScope : '';
    const actionReason = typeof payload.actionReason === 'string' ? payload.actionReason : '';
    const reasoning = typeof payload.reasoning === 'string' ? payload.reasoning : '';

    const rows = [[
      new Date().toISOString(),
      String(event.seqId),
      event.eventType,
      actor,
      actionScope,
      actionReason,
      reasoning
    ]];

    try {
      await this.appendRows(context.spreadsheetId, context.accessToken, 'LiveFeed!A1', rows);
      await this.appendRows(context.spreadsheetId, context.accessToken, 'BillingHistory!A1', rows);
    } catch {
      // Keep core ledger append path resilient if Google API call fails.
    }
  }

  async seedWorkflowEvents(workflowId: string, events: LedgerEvent[]): Promise<void> {
    const context = this.contexts.get(workflowId);
    if (!context || events.length === 0) {
      return;
    }

    const rows = events.map((event) => {
      const payload = typeof event.payload === 'object' && event.payload !== null
        ? (event.payload as Record<string, unknown>)
        : {};

      const actor = typeof payload.actor === 'string' ? payload.actor : 'system';
      const actionScope = typeof payload.actionScope === 'string' ? payload.actionScope : '';
      const actionReason = typeof payload.actionReason === 'string' ? payload.actionReason : '';
      const reasoning = typeof payload.reasoning === 'string' ? payload.reasoning : '';

      return [
        new Date().toISOString(),
        String(event.seqId),
        event.eventType,
        actor,
        actionScope,
        actionReason,
        reasoning
      ];
    });

    await this.appendRows(context.spreadsheetId, context.accessToken, 'LiveFeed!A1', rows).catch(() => undefined);
  }

  private async appendRows(spreadsheetId: string, accessToken: string, range: string, rows: string[][]): Promise<void> {
    const response = await fetch(
      'https://sheets.googleapis.com/v4/spreadsheets/' +
        encodeURIComponent(spreadsheetId) +
        '/values/' +
        encodeURIComponent(range) +
        ':append?valueInputOption=RAW',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ values: rows })
      }
    );

    if (!response.ok) {
      throw new Error(`Live sheet append failed (${response.status})`);
    }
  }
}
