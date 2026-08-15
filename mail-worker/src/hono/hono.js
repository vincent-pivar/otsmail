import { Hono } from 'hono';
const app = new Hono();

import result from '../model/result';
import { cors } from 'hono/cors';

/**
 * CORS 白名单
 *
 * 上游是 `app.use('*', cors())` —— 等于 Access-Control-Allow-Origin: *，
 * 任意站点的 JS 都能带着用户视角调这套 API。配合正文 XSS 就是完整的接管链。
 *
 * 这里改成：
 *   - 默认只允许同源（前端和 Worker 同域部署，本来就不需要跨域）
 *   - 需要额外来源（安卓 WebView 调试、独立前端域名）时，在 wrangler.toml
 *     的 [vars] 里配 allow_origin，逗号分隔多个
 *   - 原生 App（无 Origin 头）不受影响：浏览器才发 Origin，原生 HTTP 客户端不发
 */
app.use('*', (c, next) => {
	const configured = (c.env.allow_origin || '')
		.split(',')
		.map(s => s.trim())
		.filter(Boolean);

	const selfOrigin = new URL(c.req.url).origin;
	const allowList = [selfOrigin, ...configured];

	return cors({
		origin: (origin) => (allowList.includes(origin) ? origin : null),
		allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
		allowHeaders: ['Content-Type', 'Authorization', 'accept-language'],
		credentials: false,
		maxAge: 600
	})(c, next);
});

app.onError((err, c) => {
	if (err.name === 'BizError') {
		console.log(err.message);
	} else {
		console.error(err);
	}

	if (err.message === `Cannot read properties of undefined (reading 'get')`) {
		return c.json(result.fail('KV数据库未绑定 KV database not bound',502));
	}

	if (err.message === `Cannot read properties of undefined (reading 'put')`) {
		return c.json(result.fail('KV数据库未绑定 KV database not bound',502));
	}

	if (err.message === `Cannot read properties of undefined (reading 'prepare')`) {
		return c.json(result.fail('D1数据库未绑定 D1 database not bound',502));
	}

	// 非业务异常不要把内部错误原文回给客户端（可能带表名 / 堆栈信息）。
	if (err.name !== 'BizError') {
		return c.json(result.fail('Internal error', 500));
	}

	return c.json(result.fail(err.message, err.code));
});

export default app;
