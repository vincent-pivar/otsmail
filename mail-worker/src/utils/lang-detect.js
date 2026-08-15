/**
 * 轻量语言检测（零依赖）
 *
 * 只用于「正文是否已经是目标语言」的粗判，命中就跳过翻译、省一次模型调用。
 * 不追求精确，靠 Unicode 区块占比做启发式，返回 ISO 639-1 或 'und'。
 * 之所以不用 franc-min + iso-639-3：那是两个额外 npm 依赖，而我们只需要
 * 区分中/日/韩/俄/拉丁系，占比法足够且无供应链负担。
 */
export function detectLang(text) {
	if (!text || typeof text !== 'string') return 'und';
	const s = text.replace(/\s+/g, '');
	if (s.length < 4) return 'und';

	let han = 0, hira = 0, kata = 0, hangul = 0, cyr = 0, latin = 0, total = 0;
	for (const ch of s) {
		const cp = ch.codePointAt(0);
		if (cp >= 0x4e00 && cp <= 0x9fff) han++;
		else if (cp >= 0x3040 && cp <= 0x309f) hira++;
		else if (cp >= 0x30a0 && cp <= 0x30ff) kata++;
		else if (cp >= 0xac00 && cp <= 0xd7a3) hangul++;
		else if (cp >= 0x0400 && cp <= 0x04ff) cyr++;
		else if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) latin++;
		else continue;
		total++;
	}
	if (total === 0) return 'und';

	// 有假名 → 日语（即便夹汉字）
	if ((hira + kata) / total > 0.05) return 'ja';
	if (hangul / total > 0.2) return 'ko';
	if (han / total > 0.2) return 'zh';
	if (cyr / total > 0.3) return 'ru';
	if (latin / total > 0.5) return 'en'; // 拉丁系统一按 en 粗判（只为跳过同语翻译）
	return 'und';
}
