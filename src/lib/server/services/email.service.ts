import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import nodemailer from 'nodemailer';
import { glob } from 'glob';
import duration from 'parse-duration';
import { LRUCache } from 'lru-cache';
import { env } from '$lib/server/env';
import { compileTemplate, renderTemplate, type Template } from '$lib/markdown';
import { accountsService } from '$lib/server/services/accounts.service';

export interface EmailServiceSendOptions {
	accountId?: string;
	attachments?: {
		content: string | Buffer | ReadableStream;
		contentType: string;
		filename: string;
	}[];
	from?: string;
	html?: string;
	subject?: string;
	text?: string;
	to: string | string[];
}

export class EmailService {
	readonly defaultTransport = env.SMTP_URL
		? nodemailer.createTransport(env.SMTP_URL, {
				greetingTimeout: 6000,
				from: env.SMTP_SENDER
			})
		: null;

	readonly templates = new Map<string, Map<string, Template>>();

	readonly transports = new LRUCache<string, nodemailer.Transporter>({
		max: 500,
		ttl: duration('20min')
	});

	async getTransportForAccount(accountId: string) {
		let transport = this.transports.get(accountId);
		if (transport) {
			return transport;
		}
		const account = await accountsService.findAccountWithCredentials(accountId);
		if (account?.smtpUrl) {
			transport = nodemailer.createTransport(account.smtpUrl, {
				greetingTimeout: 6000,
				from: account.smtpSender || void 0
			});
		} else if (this.defaultTransport) {
			transport = this.defaultTransport;
		}
		this.transports.set(accountId, transport);
		return transport;
	}

	getTemplate(name: string, locale: string) {
		const templates = this.templates.get(name);
		if (!templates) {
			throw new Error(`Email template ${name} not found.`);
		}
		const template = templates.get(locale) || templates.get('en-GB');
		if (!template) {
			throw new Error(`Email template ${name} with locale ${locale} not found.`);
		}
		return template;
	}

	async compileTemplates(globPath: string = 'templates/emails/**/*.md') {
		const files = await glob(globPath);
		for (const file of files) {
			const [name, locale] = path.basename(file, '.md').split('.');
			if (!this.templates.has(name)) {
				this.templates.set(name, new Map());
			}
			this.templates.get(name)!.set(locale, compileTemplate(await fsp.readFile(file, 'utf-8')));
		}
	}

	async send(options: EmailServiceSendOptions) {
		const transport = options.accountId
			? await this.getTransportForAccount(options.accountId)
			: this.defaultTransport;
		if (!transport) {
			return false;
		}
		// @ts-expect-error
		const defaultFrom = transport._defaults.from;
		const result = await transport.sendMail({
			attachments: options.attachments?.map(({ content, contentType, filename }) => {
				return {
					content:
						content instanceof ReadableStream
							? // @ts-expect-error Node typings
								Readable.fromWeb(content)
							: content,
					contentType,
					filename
				};
			}),
			text: options.text,
			from: options.from || defaultFrom,
			html: options.html,
			to: options.to,
			subject: options.subject
		});
		return !!result?.accepted?.length;
	}

	async sendTemplate(
		tpl: Template,
		vars: Record<string, unknown>,
		options: EmailServiceSendOptions
	) {
		const { attributes, html } = renderTemplate(tpl, vars);
		return this.send({
			...attributes,
			...options,
			html
		});
	}

	async sendTestEmail(smtpUrl: string, from: string, to: string) {
		const transport = nodemailer.createTransport(smtpUrl, {
			greetingTimeout: 6000,
			from
		});
		return transport.sendMail({
			text: 'This is a test email from Altcha.',
			to,
			subject: 'Test email'
		});
	}
}

export const emailService = new EmailService();

emailService.compileTemplates();
