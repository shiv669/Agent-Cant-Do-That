import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './modules/app.module';

const workspaceEnvPath = resolve(process.cwd(), '../../.env');
if (existsSync(workspaceEnvPath)) {
  loadEnv({ path: workspaceEnvPath });
} else {
  loadEnv();
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix('api');
  app.enableCors();

  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port);

  console.log(`API listening on http://localhost:${port}/api/health`);
}

bootstrap();
