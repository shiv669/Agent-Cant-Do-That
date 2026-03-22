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

  const allowedOrigins = ['http://localhost:3000', 'http://localhost:3001'];

  app.setGlobalPrefix('api');
  app.enableCors({
    origin: (origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error('Origin not allowed by CORS'));
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true
  });

  const port = Number(process.env.PORT ?? 4001);
  await app.listen(port);

  console.log(`API listening on http://localhost:${port}/api/health`);
}

bootstrap();
