/**
 * 会话令牌的唯一存取入口
 *
 * 为什么要有这一层：
 *   上游把 token 直接散落在 7 处 `localStorage.getItem('token')`。localStorage
 *   对同源的任意 JS 可读，所以一旦出现 XSS，token 必然被读走外发。
 *   （正文 XSS 已在 components/shadow-html 用 DOMPurify 消毒 + CORS 收白名单，
 *     但纵深防御不该只靠一层。）
 *
 * 当前实现：
 *   token 主要放在内存（模块级变量），localStorage 只作为「刷新页面后恢复」
 *   的持久层，且加了 tokenVersion 便于将来一次性失效所有旧会话。
 *   收益：所有读写集中一处，将来换成 httpOnly Cookie 只改这个文件。
 *
 * TODO(下一阶段)：改为后端下发 httpOnly + Secure + SameSite=Lax Cookie，
 *   同时保留 Authorization 头以支持安卓原生客户端（原生客户端不受 XSS 影响，
 *   继续用 Bearer 头即可）。改造点：
 *     - worker: login 时 Set-Cookie；security.js 支持从 Cookie 读 token
 *     - worker: 为写操作加 CSRF token 校验（Cookie 方案的必备配套）
 *     - 前端: 本文件的 get/set/clear 改为 no-op + withCredentials
 */

const STORAGE_KEY = 'token';
const VERSION_KEY = 'token_v';
const CURRENT_VERSION = '2';

let memoryToken = null;

function readPersisted() {
	try {
		// 版本不匹配说明是旧格式会话，直接作废，避免脏数据。
		if (localStorage.getItem(VERSION_KEY) !== CURRENT_VERSION) {
			localStorage.removeItem(STORAGE_KEY);
			localStorage.removeItem(VERSION_KEY);
			return null;
		}
		return localStorage.getItem(STORAGE_KEY);
	} catch (e) {
		// 隐私模式 / 存储被禁用时不要让整个应用崩掉
		return null;
	}
}

export function getToken() {
	if (memoryToken) return memoryToken;
	memoryToken = readPersisted();
	return memoryToken;
}

export function setToken(token) {
	memoryToken = token || null;
	try {
		if (token) {
			localStorage.setItem(STORAGE_KEY, token);
			localStorage.setItem(VERSION_KEY, CURRENT_VERSION);
		} else {
			localStorage.removeItem(STORAGE_KEY);
			localStorage.removeItem(VERSION_KEY);
		}
	} catch (e) {
		// 存不下就只用内存态：本次会话可用，刷新后需重新登录
	}
}

export function clearToken() {
	setToken(null);
}

export function hasToken() {
	return !!getToken();
}

export default { getToken, setToken, clearToken, hasToken };
