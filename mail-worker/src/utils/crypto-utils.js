const encoder = new TextEncoder();

/**
 * 口令哈希
 *
 * 上游用的是「单轮 SHA-256(salt + password)」。SHA-256 是为速度设计的，
 * GPU 每秒能算数十亿次，一旦 D1 泄露，弱口令基本等于明文。
 *
 * 这里改成 PBKDF2-HMAC-SHA256，并给新哈希加 `pbkdf2$<轮数>$` 前缀做版本标记。
 *
 * ⚠️ 轮数与 Workers CPU 限额的权衡（重要）
 *   Workers 免费档限制 10ms CPU/请求，付费档默认 30s。PBKDF2 是纯 CPU 计算：
 *   本机实测 10000 轮≈6ms、100000 轮≈52ms、210000 轮（OWASP 推荐）≈120ms。
 *   也就是说 **免费档跑不了高轮数，登录会被 CPU 超限打断（error 1102）**。
 *   所以轮数做成可配：wrangler.toml 的 [vars] 里 pwd_iterations。
 *     - Workers 付费档：留空即可（默认 210000，OWASP 推荐值）
 *     - Workers 免费档：设 pwd_iterations = 8000 左右，仍远强于单轮 SHA-256
 *   哈希里带着轮数，改配置不会让老用户登不上。
 *
 * 兼容性：verifyPassword 同时认旧格式（无前缀的单轮 SHA-256），所以从旧库
 * 迁移过来的用户可以照常登录；登录成功后由 login-service 就地升级哈希。
 */

const DEFAULT_ITERATIONS = 210000;
const MIN_ITERATIONS = 1000;
const PBKDF2_PREFIX = 'pbkdf2$';

function bufToB64(buf) {
	return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

const saltHashUtils = {

	generateSalt(length = 16) {
		const array = new Uint8Array(length);
		crypto.getRandomValues(array);
		return btoa(String.fromCharCode(...array));
	},

	/**
	 * 解析本次要用的轮数。
	 * @param {object} [c] hono context；给了就读 c.env.pwd_iterations
	 */
	resolveIterations(c) {
		const raw = Number(c?.env?.pwd_iterations);
		if (!raw || Number.isNaN(raw)) return DEFAULT_ITERATIONS;
		return Math.max(MIN_ITERATIONS, Math.floor(raw));
	},

	/**
	 * @param {string} password
	 * @param {object} [c] hono context（可选，用于读取 pwd_iterations 配置）
	 */
	async hashPassword(password, c) {
		const salt = this.generateSalt();
		const hash = await this.genHashPassword(password, salt, c);
		return { salt, hash };
	},

	/** 生成新哈希，始终用 PBKDF2 */
	async genHashPassword(password, salt, c) {
		return await this.pbkdf2(password, salt, this.resolveIterations(c));
	},

	async pbkdf2(password, salt, iterations) {
		const keyMaterial = await crypto.subtle.importKey(
			'raw',
			encoder.encode(password),
			{ name: 'PBKDF2' },
			false,
			['deriveBits']
		);
		const bits = await crypto.subtle.deriveBits(
			{
				name: 'PBKDF2',
				salt: encoder.encode(salt),
				iterations,
				hash: 'SHA-256'
			},
			keyMaterial,
			256
		);
		return `${PBKDF2_PREFIX}${iterations}$${bufToB64(bits)}`;
	},

	/** 旧格式：单轮 SHA-256(salt + password)，仅用于校验历史数据 */
	async legacySha256(password, salt) {
		const data = encoder.encode(salt + password);
		const hashBuffer = await crypto.subtle.digest('SHA-256', data);
		return bufToB64(hashBuffer);
	},

	/** 该哈希是否为需要升级的旧格式 */
	isLegacyHash(storedHash) {
		return !!storedHash && !storedHash.startsWith(PBKDF2_PREFIX);
	},

	async verifyPassword(inputPassword, salt, storedHash) {
		if (!storedHash) return false;

		if (storedHash.startsWith(PBKDF2_PREFIX)) {
			// pbkdf2$<iterations>$<b64>
			const parts = storedHash.split('$');
			const iterations = Number(parts[1]);
			if (!iterations || Number.isNaN(iterations)) return false;
			const computed = await this.pbkdf2(inputPassword, salt, iterations);
			return this.timingSafeEqual(computed, storedHash);
		}

		// 旧格式回退
		const legacy = await this.legacySha256(inputPassword, salt);
		return this.timingSafeEqual(legacy, storedHash);
	},

	/** 定长比较，避免按字符早退泄露信息 */
	timingSafeEqual(a, b) {
		if (typeof a !== 'string' || typeof b !== 'string') return false;
		if (a.length !== b.length) return false;
		let diff = 0;
		for (let i = 0; i < a.length; i++) {
			diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
		}
		return diff === 0;
	},

	/**
	 * 随机口令
	 *
	 * 上游用 Math.random()，它不是密码学安全的随机源（V8 的 xorshift128+ 可从
	 * 少量输出反推内部状态）。批量建号接口 /public/addUser 用它生成用户初始密码，
	 * 等于可预测。改用 crypto.getRandomValues，并去掉取模偏置。
	 */
	genRandomPwd(length = 16) {
		const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*';
		const charsLen = chars.length;
		// 拒绝采样上界：落在 [limit, 256) 的字节丢弃，保证均匀分布
		const limit = 256 - (256 % charsLen);
		let result = '';
		const buf = new Uint8Array(length * 2);
		while (result.length < length) {
			crypto.getRandomValues(buf);
			for (let i = 0; i < buf.length && result.length < length; i++) {
				if (buf[i] < limit) {
					result += chars.charAt(buf[i] % charsLen);
				}
			}
		}
		return result;
	}
};

export default saltHashUtils;
