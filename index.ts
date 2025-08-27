import * as cheerio from 'cheerio';
import { XMLParser } from 'fast-xml-parser';

import config from './config.json' with { type: 'json' };

export default {
	async fetch(_request, env, ctx) {
		ctx.waitUntil(read(env));
		return new Response('OK');
	},

	async queue(batch, env) {
		for (const message of batch.messages) {
			const item = message.body;
			console.log("processing", item);

			if (item.content) {
				if (item.content.startsWith("http")) {
					const res = await fetch(item.content);
					const [content] = await env.AI.toMarkdown([
						{
							name: "html",
							blob: new Blob(
								[await res.arrayBuffer()],
								{ type: "text/html" }
							),
						},
					]);
					item.content = content?.data ?? "Error fetching content";
				}

				const result: AiSummarizationOutput = await env.AI.run(
					"@cf/facebook/bart-large-cnn",
					{ input_text: item.content }
				);
				item.content = result.summary;
			}

			const response = await fetch(env.WEBHOOK_URL, {
				body: JSON.stringify({
					text: [`${item.host}: *${item.title}*:`, item.category, item.content, `<${item.url}>`].filter(Boolean).join('\n'),
				}),
				headers: { 'Content-Type': 'application/json; charset=UTF-8' },
				method: 'POST',
			});
			const text = await response.text();
			if (!response.ok) {
				console.error(text);
				message.retry();
				continue;
			}

			message.ack();
		}
	},

	async scheduled(controller, env, ctx) {
		switch (controller.cron) {
			// every day of the month at 9:00 AM
			case '0 9 * * *': return ctx.waitUntil(read(env));
			default: return null as never;
		}
	},
} satisfies ExportedHandler<Env, Item>

interface Item {
	host: string;
	category: string;
	title: string;
	content?: string;
	date: string;
	url: string;
}

async function read(env: Env) {
	const items: Item[] = [];

	for await (const url of config as string[]) {
		const { hostname: host, origin } = new URL(url);

		const response = await fetch(url);
		const body = await response.text();
		const parser = new XMLParser();
		const doc = parser.parse(body);

		const contentType = response.headers.get('content-type')?.split(';')[0] || '';
		switch (contentType) {
			case 'application/xml':
			case 'application/rss+xml':
			case 'text/xml': {
				doc.rss.channel.item.forEach((item: any) => {
					items.push({
						host,
						category: Array.isArray(item.category) ? item.category.join(' / ') : item.category,
						title: item.title,
						content: item.description,
						date: new Date(item.pubDate).toJSON(),
						url: item.link,
					});
				});
				break;
			}
			case 'application/atom+xml': {
				doc.feed.entry.forEach((entry: any) => {
					items.push({
						host,
						category: "",
						title: entry.title,
						content: entry.summary, // entry.content,
						date: new Date(entry.published).toJSON(),
						url: entry.link ?? entry.id,
					});
				});
				break;
			}
			case 'text/html': {
				const $ = cheerio.load(body);
				for (const article of $('main').find('article')) {
					const a = $(article).find('a').last();
					const p = $(article).find('p').first();

					const url = new URL(a.attr('href') ?? '', origin).href;

					items.push({
						host,
						category: "",
						title: a.text(),
						content: url,
						date: new Date(p.text()).toJSON(),
						url,
					});
				}
				break;
			}
			default: {
				console.warn(`Unknown content type: ${contentType} for ${url}`);
				break;
			}
		}
	}

	const yesterday = new Date();
	yesterday.setDate(yesterday.getDate() - 1);

	const recent = items.filter((item) => new Date(item.date) > yesterday);
	console.log(`processed: ${recent.length} of ${items.length}`);

	await env.QUEUE.sendBatch(recent.map((body) => ({ body, contentType: "json" })));
}
