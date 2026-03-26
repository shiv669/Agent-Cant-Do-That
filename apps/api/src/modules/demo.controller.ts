import { Controller, ForbiddenException, Get, Post, Req } from '@nestjs/common';
import { DemoTokenService } from './demo-token.service';

@Controller('demo/admin')
export class DemoController {
  constructor(private readonly demoTokenService: DemoTokenService) {}

  private authorize(request: { headers: Record<string, string | string[] | undefined> }) {
    const configured = process.env.DEMO_ADMIN_KEY?.trim();
    if (!configured) {
      throw new ForbiddenException({ reason: 'DEMO_ADMIN_KEY is not configured' });
    }

    const header = request.headers['x-demo-admin-key'];
    const provided = (Array.isArray(header) ? header[0] : header)?.trim();
    if (!provided || provided !== configured) {
      throw new ForbiddenException({ reason: 'Invalid x-demo-admin-key' });
    }
  }

  @Post('bootstrap-tokens')
  async bootstrap(@Req() req: { headers: Record<string, string | string[] | undefined> }) {
    this.authorize(req);
    return this.demoTokenService.bootstrapFromCiba();
  }

  @Post('clear-tokens')
  async clear(@Req() req: { headers: Record<string, string | string[] | undefined> }) {
    this.authorize(req);
    return this.demoTokenService.clear();
  }

  @Get('status')
  async status(@Req() req: { headers: Record<string, string | string[] | undefined> }) {
    this.authorize(req);
    return this.demoTokenService.status();
  }
}
