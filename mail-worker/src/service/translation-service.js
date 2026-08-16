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

/**
 * 邮件一键翻译（Cloudflare Workers AI）
 *
 * 结果按 (emailId, targetLang) 缓存到 D1，重复翻译直接命中不再调模型。
 * 若正文已是目标语言则跳过（省一次调用）。
 *
 * 注意：AI binding 在 otsmail 里叫 c.env.ai（小写，见 wrangler.toml [ai]）。
 *
 * ⚠️ 关键教训：不要逼 8B 小模型（llama-3.1-8b-instruct-fast）吐结构化 JSON，
 *    它经常返回带解释文字/截断/非法转义的输出，导致 502 AI bad output。
 *    改为「纯文本翻译」策略：主题、正文各一次调用，模型只输出译文本身，最稳。
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

		if (!c.env.ai) throw new BizError('AI 未配置 AI binding not configured', 503);

		const e = await orm(c).select().from(email)
			.where(and(eq(email.emailId, emailId), eq(email.userId, userId)))
			.get();
		if (!e) throw new BizError('邮件不存在 Email not found', 404);

		const rawSource = e.content || e.text || '';
		const detected = detectLang(htmlToPlainText(rawSource).slice(0, 500));
		if (detected !== 'und' && detected === targetLang) {
			return { alreadyInTargetLang: true, sourceLang: detected };
		}

		let plainText = htmlToPlainText(rawSource);
		let truncated = false;
		if (plainText.length > MAX_INPUT_CHARS) {
			plainText = plainText.slice(0, MAX_INPUT_CHARS) + '\n\n[...]';
			truncated = true;
		}

		// 主题与正文分别翻译（纯文本），任一失败都不至于整体 502。
		const subjectSrc = (e.subject || '').trim();
		const translatedSubject = subjectSrc
			? await translateText(c.env.ai, subjectSrc, targetLang, true)
			: '';
		const translatedBody = plainText.trim()
			? await translateText(c.env.ai, plainText, targetLang, false)
			: '';

		const translatedContentHtml = paragraphsToHtml(translatedBody);

		await orm(c).insert(emailTranslation).values({
			emailId, targetLang, userId,
			translatedSubject,
			translatedContent: translatedContentHtml,
			sourceLang: detected !== 'und' ? detected : null,
			model: MODEL_ID,
		}).onConflictDoNothing().run();

		return {
			translatedSubject,
			translatedContent: translatedContentHtml,
			sourceLang: detected !== 'und' ? detected : null,
			fromCache: false,
			truncated,
		};
	},
};

/**
 * 纯文本翻译：模型只输出译文，不套 JSON、不加解释。
 * isSubject=true 时约束「保持单行、简短」。
 */
async function translateText(ai, srcText, targetLang, isSubject) {
	const langName = LANG_NAMES[targetLang];
	const systemPrompt =
		`You are a professional translator. Translate the user's text into ${langName}.\n` +
		`Output ONLY the translation itself — no preamble, no explanation, no quotes, no markdown.\n` +
		`Do NOT translate proper names, email addresses, URLs, or code. Keep numbers, dates, codes unchanged.\n` +
		(isSubject
			? `This is an email subject line: keep it on a single line and concise.`
			: `Preserve paragraph breaks. Keep the meaning faithful and natural.`);

	let resp;
	try {
		resp = await ai.run(MODEL_ID, {
			messages: [
				{ role: 'system', content: systemPrompt },
				{ role: 'user', content: srcText },
			],
			max_tokens: isSubject ? 256 : 4096,
			temperature: 0.2,
		});
	} catch (err) {
		if (err?.status === 429 || /rate limit/i.test(err?.message || '')) {
			throw new BizError('AI 调用超出限额 AI rate limited', 429);
		}
		if (/timeout/i.test(err?.message || '')) {
			throw new BizError('AI 调用超时 AI timeout', 504);
		}
		throw new BizError('AI 调用失败 AI call failed', 502);
	}

	// Workers AI 文本生成返回 { response: "..." }
	let out = (resp && typeof resp.response === 'string') ? resp.response : '';
	out = cleanModelText(out);
	if (!out) throw new BizError('AI 返回为空 AI empty output', 502);
	return out;
}

/** 剥掉小模型爱加的包裹：代码围栏、成对引号、"Here is the translation:" 前缀。 */
function cleanModelText(text) {
	let s = String(text || '').trim();
	// 去 ``` 围栏
	s = s.replace(/^```[a-zA-Z]*\s*/,'').replace(/\s*```$/,'').trim();
	// 去常见前缀
	s = s.replace(/^(here('| i)s (the )?(translation|translated text)\s*:?\s*)/i, '').trim();
	// 去整体成对引号
	if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith('“') && s.endsWith('”'))) {
		s = s.slice(1, -1).trim();
	}
	return s;
}

export default translationService;
