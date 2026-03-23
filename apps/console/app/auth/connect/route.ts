import { auth0 } from '@/lib/auth0';
import { NextResponse } from 'next/server';

export async function GET() {
	try {
		return await auth0.connectAccount({
			connection: 'google-oauth2',
			scopes: [
				'openid',
				'profile',
				'email',
				'https://www.googleapis.com/auth/spreadsheets'
			],
			returnTo: '/'
		});
	} catch (error: any) {
		return NextResponse.json(
			{
				error: error?.message || 'connect_account_failed',
				code: error?.code,
				cause: error?.cause
			},
			{ status: 500 }
		);
	}
}
