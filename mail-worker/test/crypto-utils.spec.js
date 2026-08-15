import { describe, it, expect } from 'vitest';
import cryptoUtils from '../src/utils/crypto-utils.js';

describe('crypto-utils / 口令哈希', () => {

	it('新哈希使用 PBKDF2 并标记轮数', async () => {
		const { salt, hash } = await cryptoUtils.hashPassword('CorrectHorse42');
		expect(hash.startsWith('pbkdf2$210000$')).toBe(true);
		expect(salt).toBeTruthy();
		expect(cryptoUtils.isLegacyHash(hash)).toBe(false);
	});

	it('正确口令通过、错误口令拒绝', async () => {
		const { salt, hash } = await cryptoUtils.hashPassword('CorrectHorse42');
		await expect(cryptoUtils.verifyPassword('CorrectHorse42', salt, hash)).resolves.toBe(true);
		await expect(cryptoUtils.verifyPassword('CorrectHorse43', salt, hash)).resolves.toBe(false);
		await expect(cryptoUtils.verifyPassword('', salt, hash)).resolves.toBe(false);
	});

	it('同口令两次哈希不同（salt 随机）', async () => {
		const a = await cryptoUtils.hashPassword('same');
		const b = await cryptoUtils.hashPassword('same');
		expect(a.hash).not.toBe(b.hash);
		expect(a.salt).not.toBe(b.salt);
	});

	describe('轮数可配（Workers 免费档 CPU 限制）', () => {
		it('无配置时用默认 210000', () => {
			expect(cryptoUtils.resolveIterations(undefined)).toBe(210000);
			expect(cryptoUtils.resolveIterations({ env: {} })).toBe(210000);
		});

		it('读取 env.pwd_iterations，字符串也认', () => {
			expect(cryptoUtils.resolveIterations({ env: { pwd_iterations: 8000 } })).toBe(8000);
			expect(cryptoUtils.resolveIterations({ env: { pwd_iterations: '12000' } })).toBe(12000);
		});

		it('低于下限夹到 1000，非法值回落默认', () => {
			expect(cryptoUtils.resolveIterations({ env: { pwd_iterations: 5 } })).toBe(1000);
			expect(cryptoUtils.resolveIterations({ env: { pwd_iterations: 'abc' } })).toBe(210000);
		});

		it('调整轮数后，旧轮数的哈希仍能登录（轮数写在哈希里）', async () => {
			const lowCtx = { env: { pwd_iterations: 8000 } };
			const { salt, hash } = await cryptoUtils.hashPassword('MyPass123', lowCtx);
			expect(hash.startsWith('pbkdf2$8000$')).toBe(true);

			// 配置改回默认后，老哈希依然可校验
			await expect(cryptoUtils.verifyPassword('MyPass123', salt, hash)).resolves.toBe(true);
		});
	});

	describe('旧库兼容（单轮 SHA-256）', () => {
		it('旧格式哈希被识别为 legacy 且仍可登录', async () => {
			const salt = cryptoUtils.generateSalt();
			const legacy = await cryptoUtils.legacySha256('OldPwd1', salt);
			expect(cryptoUtils.isLegacyHash(legacy)).toBe(true);
			await expect(cryptoUtils.verifyPassword('OldPwd1', salt, legacy)).resolves.toBe(true);
			await expect(cryptoUtils.verifyPassword('OldPwd2', salt, legacy)).resolves.toBe(false);
		});

		it('空哈希不通过', async () => {
			await expect(cryptoUtils.verifyPassword('x', 'y', '')).resolves.toBe(false);
			await expect(cryptoUtils.verifyPassword('x', 'y', null)).resolves.toBe(false);
		});
	});

	describe('随机口令使用 CSPRNG', () => {
		it('长度正确且无碰撞', () => {
			const set = new Set();
			for (let i = 0; i < 300; i++) set.add(cryptoUtils.genRandomPwd(16));
			expect(set.size).toBe(300);
			expect(cryptoUtils.genRandomPwd(16)).toHaveLength(16);
			expect(cryptoUtils.genRandomPwd(8)).toHaveLength(8);
		});

		it('字符分布覆盖足够广（无明显偏置）', () => {
			const bulk = Array.from({ length: 80 }, () => cryptoUtils.genRandomPwd(16)).join('');
			expect(new Set(bulk).size).toBeGreaterThan(40);
		});
	});

	describe('timingSafeEqual', () => {
		it('相同为 true，不同/长度不同/非字符串为 false', () => {
			expect(cryptoUtils.timingSafeEqual('abc', 'abc')).toBe(true);
			expect(cryptoUtils.timingSafeEqual('abc', 'abd')).toBe(false);
			expect(cryptoUtils.timingSafeEqual('abc', 'abcd')).toBe(false);
			expect(cryptoUtils.timingSafeEqual(null, 'abc')).toBe(false);
			expect(cryptoUtils.timingSafeEqual(undefined, undefined)).toBe(false);
		});
	});
});
