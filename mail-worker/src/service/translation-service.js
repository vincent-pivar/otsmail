import { and, eq } from 'drizzle-orm';
import orm from '../entity/orm';
import { emailTranslation } from '../entity/email-translation';
import email from '../entity/email';
import BizError from '../error/biz-error';
import {
	MODEL_ID, SUPPORTED_TARGET_LANGS, LANG_NAMES, MAX_INPUT_CHARS,
} from '../const/translation-const';
import { htmlToPlainText, paragraphsToHtml } from '../utils/html-utils';
import { detectLang } from '../utils/lang-detect';
import settingService from './setting-service';

/**
 * 邮件一键翻译
 *
 * 优先 DeepL（env.deepl_key，Worker Secret）：tag_handling=html 直接翻译富文本，
 *   标签结构原样保留 → 排版不走样（用户反馈"排版和原文不一样"的根因是旧的纯文本方案）。
 * 无 key 时回退 Cloudflare Workers AI（纯文本，会丢排版）。
 *
 * 结果按 (emailId, targetLang) 缓存到 D1，重复翻译直接命中。
 */
const translationService = {
	async translate(c, { emailId, targetLang, userId }) {
		if (!SUPPORTED_TARGET_LANGS.includes(targetLang)) {
			throw new BizError('不支持的目标语言 Unsupported target language', 400);
		}

		const cached = await orm(c).select().from(emailTranslation)
			.where(and(
				eq(emailTranslation.emailId, emailId),
				eq(emailTranslation.targetLang, targetLang),
				eq(emailTranslation.userId, userId),
			)).get();
		if (cached) {
			return {
				translatedSubject: cached.translatedSubject,
				translatedContent: cached.translatedContent,
				sourceLang: cached.sourceLang,
				fromCache: true,
			};
		}

		const e = await orm(c).select().from(email)
			.where(and(eq(email.emailId, emailId), eq(email.userId, userId)))
			.get();
		if (!e) throw new BizError('邮件不存在 Email not found', 404);

		const rawHtml = e.content || '';
		const rawText = e.text || '';
		const detected = detectLang(htmlToPlainText(rawHtml || rawText).slice(0, 500));
		if (detected !== 'und' && detected === targetLang) {
			return { alreadyInTargetLang: true, sourceLang: detected };
		}

		let result;
		// DeepL key 优先级：管理员在设置页填的 setting.deeplKey > Worker Secret env.deepl_key
		let deeplKey = c.env.deepl_key || '';
		try {
			const s = await settingService.query(c);
			if (s && s.deeplKey) deeplKey = s.deeplKey;
		} catch (_) { /* 设置未就绪时忽略，回退 env */ }

		if (deeplKey) {
			result = await translateByDeepL(deeplKey, {
				subject: e.subject || '',
				html: rawHtml,
				text: rawText,
				targetLang,
			});
		} else if (c.env.ai) {
			result = await translateByWorkersAI(c.env.ai, {
				subject: e.subject || '',
				text: htmlToPlainText(rawHtml || rawText),
				targetLang,
			});
		} else {
			throw new BizError('未配置翻译服务 No translation provider', 503);
		}

		await orm(c).insert(emailTranslation).values({
			emailId, targetLang, userId,
			translatedSubject: result.subject,
			translatedContent: result.content,
			sourceLang: result.sourceLang || (detected !== 'und' ? detected : null),
			model: result.model,
		}).onConflictDoNothing().run();

		return {
			translatedSubject: result.subject,
			translatedContent: result.content,
			sourceLang: result.sourceLang || (detected !== 'und' ? detected : null),
			fromCache: false,
		};
	},
};

/**
 * DeepL 翻译。免费档 key 以 :fx 结尾 → api-free；否则 api.deepl.com。
 * 正文走 tag_handling=html 保排版；主题走纯文本。
 */
async function translateByDeepL(key, { subject, html, text, targetLang }) {
	const endpoint = key.trim().endsWith(':fx')
		? 'https://api-free.deepl.com/v2/translate'
		: 'https://api.deepl.com/v2/translate';
	const deeplLang = DEEPL_LANG[targetLang] || targetLang.toUpperCase();

	// 正文：有 HTML 用 html 模式；只有纯文本就退化为普通文本翻译再包段落
	const hasHtml = /<[a-z][\s\S]*>/i.test(html);
	let bodyPayload, translatedBody, detectedLang = null;

	if (hasHtml) {
		let src = html;
		if (src.length > MAX_INPUT_CHARS) src = src.slice(0, MAX_INPUT_CHARS);
		const r = await callDeepL(endpoint, key, {
			text: [src], target_lang: deeplLang,
			tag_handling: 'html', tag_handling_version: 'v2',
		});
		translatedBody = r.translations[0].text;
		detectedLang = r.translations[0].detected_source_language;
	} else {
		let src = text || '';
		if (src.length > MAX_INPUT_CHARS) src = src.slice(0, MAX_INPUT_CHARS);
		const r = await callDeepL(endpoint, key, { text: [src], target_lang: deeplLang });
		translatedBody = paragraphsToHtml(r.translations[0].text);
		detectedLang = r.translations[0].detected_source_language;
	}

	let translatedSubject = subject;
	if (subject.trim()) {
		const rs = await callDeepL(endpoint, key, { text: [subject], target_lang: deeplLang });
		translatedSubject = rs.translations[0].text;
	}

	return {
		subject: translatedSubject,
		content: translatedBody,
		sourceLang: detectedLang ? detectedLang.toLowerCase() : null,
		model: 'deepl',
	};
}

async function callDeepL(endpoint, key, body) {
	let resp;
	try {
		resp = await fetch(endpoint, {
			method: 'POST',
			headers: {
				'Authorization': `DeepL-Auth-Key ${key}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(body),
		});
	} catch (err) {
		throw new BizError('DeepL 调用失败 DeepL request failed', 502);
	}
	if (resp.status === 456) throw new BizError('DeepL 本月额度已用尽 DeepL quota exceeded', 429);
	if (resp.status === 403) throw new BizError('DeepL 鉴权失败 DeepL auth failed', 502);
	if (!resp.ok) throw new BizError(`DeepL 返回异常 (${resp.status})`, 502);
	const data = await resp.json();
	if (!data?.translations?.length) throw new BizError('DeepL 返回为空 DeepL empty', 502);
	return data;
}

/** DeepL 目标语言码（多数与大写 ISO 一致，中/英有区分） */
const DEEPL_LANG = {
	zh: 'ZH', en: 'EN-US', ja: 'JA', ko: 'KO', fr: 'FR',
	de: 'DE', es: 'ES', ru: 'RU', pt: 'PT-PT', it: 'IT',
};

/** 回退：Workers AI 纯文本翻译（无 DeepL key 时） */
async function translateByWorkersAI(ai, { subject, text, targetLang }) {
	const langName = LANG_NAMES[targetLang];
	async function one(src, isSubject) {
		if (!src.trim()) return '';
		const sys = `You are a professional translator. Translate into ${langName}. ` +
			`Output ONLY the translation, no preamble/quotes/markdown. ` +
			`Keep names, emails, URLs, numbers unchanged.` +
			(isSubject ? ' Single line.' : ' Preserve paragraph breaks.');
		const resp = await ai.run(MODEL_ID, {
			messages: [{ role: 'system', content: sys }, { role: 'user', content: src }],
			max_tokens: isSubject ? 256 : 4096, temperature: 0.2,
		});
		return cleanModelText(resp?.response || '');
	}
	const s = await one(subject, true);
	const b = await one(text, false);
	return { subject: s, content: paragraphsToHtml(b), sourceLang: null, model: MODEL_ID };
}

function cleanModelText(text) {
	let s = String(text || '').trim();
	s = s.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '').trim();
	s = s.replace(/^(here('| i)s (the )?(translation|translated text)\s*:?\s*)/i, '').trim();
	if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith('“') && s.endsWith('”'))) {
		s = s.slice(1, -1).trim();
	}
	return s;
}

export default translationService;
