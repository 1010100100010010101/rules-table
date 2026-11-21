import { callModel } from "./model";
import { splitSentences } from "./split";
import { DurableObject } from "cloudflare:workers";

/**
 * Welcome to Cloudflare Workers! This is your first Durable Objects application.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your Durable Object in action
 * - Run `npm run deploy` to publish your application
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/durable-objects
 */


/** A Durable Object's behavior is defined in an exported Javascript class */
export class MyDurableObject extends DurableObject {
	/**
	 * The constructor is invoked once upon creation of the Durable Object, i.e. the first call to
	 * 	`DurableObjectStub::get` for a given identifier (no-op constructors can be omitted)
	 *
	 * @param ctx - The interface for interacting with Durable Object state
	 * @param env - The interface to reference bindings declared in wrangler.jsonc
	 */
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	/**
	 * The Durable Object exposes an RPC method sayHello which will be invoked when a Durable
	 *  Object instance receives a request from a Worker via the same method invocation on the stub
	 *
	 * @param name - The name provided to a Durable Object instance from a Worker
	 * @returns The greeting to be sent back to the Worker
	 */
	async sayHello(name: string): Promise<string> {
		return `Hello, ${name}!`;
	}
}

export default {
	/**
	 * This is the standard fetch handler for a Cloudflare Worker
	 *
	 * @param request - The request submitted to the Worker from the client
	 * @param env - The interface to reference bindings declared in wrangler.jsonc
	 * @param ctx - The execution context of the Worker
	 * @returns The response to be sent back to the client
	 */
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);

		// 測試模型連線
		if (url.pathname === "/api/ping-model") {
			const res = await callModel(env as any, "你是測試助理。", "用一句繁體中文說：連線成功。");
			return Response.json(res);
		}
		if (url.pathname === "/api/split") {
			const file = await env.ASSETS.fetch(new URL("/rules/night-market.txt", request.url));
			const sentences = splitSentences(await file.text());
			return Response.json({ count: sentences.length, sentences });
		}

		// 測試房間物件（範本原本的功能，之後做房間會改寫）
		if (url.pathname === "/api/ping-room") {
			const stub = env.MY_DURABLE_OBJECT.getByName("foo");
			const greeting = await stub.sayHello("world");
			return new Response(greeting);
		}

		// 其他路徑交給靜態網頁
		return env.ASSETS.fetch(request);
	},
} satisfies ExportedHandler<Env>;
