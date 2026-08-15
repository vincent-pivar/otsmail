import { defineConfig } from 'vitest/config';

/**
 * 说明：上游的 vitest 配置用 @cloudflare/vitest-pool-workers 并指向一个不存在的
 * wrangler.jsonc，跑起来直接 ParseError，等于没有测试。
 *
 * 这里改成标准的 node 环境测试，覆盖纯逻辑单元（口令哈希、HTML 消毒、CORS 白名单
 * 判定）。这些模块只依赖 WebCrypto 和 linkedom，Node 18+ 原生具备，不需要
 * workerd 运行时，跑得快也不需要 Cloudflare 凭证。
 *
 * 需要真正跑在 workerd 里的集成测试（D1/KV/R2 绑定）后续单独加一份
 * vitest.workers.config.js。
 */
export default defineConfig({
	test: {
		environment: 'node',
		include: ['test/**/*.spec.js'],
		exclude: ['test/**/*.workers.spec.js'],
		testTimeout: 20000
	}
});
