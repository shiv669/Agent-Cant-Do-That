import { auth0 } from '@/lib/auth0';

export async function GET() {
  const domain = process.env.AUTH0_DOMAIN;
  const myAccountAudience = process.env.AUTH0_MY_ACCOUNT_AUDIENCE ||
    (domain ? `https://${domain}/me/` : undefined);

  return auth0.startInteractiveLogin({
    authorizationParameters: {
      audience: myAccountAudience,
      scope:
        'openid profile email offline_access create:me:connected_accounts read:me:connected_accounts delete:me:connected_accounts'
    }
  });
}
