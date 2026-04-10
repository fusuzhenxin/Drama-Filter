const express = require('express');
const path = require('path');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;
const deepSeekApiKey = process.env.DEEPSEEK_API_KEY;
const deepSeekBaseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function countMatches(text, patterns) {
  return patterns.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
}

function normalizeModelResult(result) {
  const usefulScore = clamp(Math.round(Number(result.usefulScore)), 1, 10);
  const troubleScore = clamp(Math.round(Number(result.troubleScore)), 1, 10);
  const regretTomorrow = String(result.regretTomorrow).trim() === '是' ? '是' : '否';
  const mirror = typeof result.mirror === 'string' && result.mirror.trim()
    ? result.mirror.trim()
    : '这句话值不值得发，你心里其实已经有答案了。';

  return {
    usefulScore,
    troubleScore,
    regretTomorrow,
    mirror
  };
}

function analyzeText(input) {
  const text = input.trim();
  const normalized = text.toLowerCase();

  const usefulPatterns = [
    /怎么/,
    /如何/,
    /建议/,
    /请教/,
    /总结/,
    /通知/,
    /时间/,
    /地点/,
    /方案/,
    /解决/,
    /帮忙/,
    /谢谢/,
    /麻烦/,
    /步骤/,
    /结果/
  ];

  const riskPatterns = [
    /傻/,
    /垃圾/,
    /恶心/,
    /废物/,
    /滚/,
    /举报/,
    /曝光/,
    /别装/,
    /有病/,
    /真无语/,
    /气死/,
    /讨厌/,
    /恨/,
    /最差/,
    /看不起/
  ];

  const regretPatterns = [
    /前任/,
    /老板/,
    /同事/,
    /领导/,
    /喝多/,
    /凌晨/,
    /破防/,
    /忍不住/,
    /算了我说了/,
    /就当我疯了/,
    /拉黑/,
    /分手/,
    /辞职/,
    /冲动/,
    /忍不了/
  ];

  const emotionalPatterns = [
    /!{2,}/,
    /？{2,}/,
    /。{2,}/,
    /呵呵/,
    /笑死/,
    /离谱/,
    /受不了/,
    /凭什么/,
    /你凭什么/
  ];

  const usefulHits = countMatches(normalized, usefulPatterns);
  const riskHits = countMatches(normalized, riskPatterns);
  const regretHits = countMatches(normalized, regretPatterns);
  const emotionalHits = countMatches(normalized, emotionalPatterns);

  const hasConcreteInfo = /(\d{1,2}[:：]\d{2})|(今天|明天|周一|周二|周三|周四|周五|地点|地址|链接|清单|流程)/.test(normalized);
  const isShortBurst = text.length > 0 && text.length <= 8;
  const hasQuestion = /[?？]/.test(text);
  const hasSecondPersonAttack = /(你|你们).{0,6}(真的|就是|太|别|滚|烦|有病|恶心|离谱)/.test(normalized);

  let usefulScore = 4 + usefulHits * 1.2 + (hasConcreteInfo ? 2 : 0) + (hasQuestion ? 1 : 0);
  usefulScore -= emotionalHits * 0.8;
  usefulScore -= riskHits * 0.4;
  usefulScore -= isShortBurst ? 1.5 : 0;

  let troubleScore = 2 + riskHits * 1.8 + emotionalHits * 1.1 + (hasSecondPersonAttack ? 2.5 : 0);
  troubleScore += /朋友圈|公开|评论区/.test(normalized) ? 1.2 : 0;
  troubleScore += /都给我看|某些人|有人急了/.test(normalized) ? 1.6 : 0;
  troubleScore -= usefulHits * 0.2;

  const regretRaw = regretHits + emotionalHits + (hasSecondPersonAttack ? 1 : 0) + (text.length >= 60 ? 0.5 : 0);
  const regretYes = regretRaw >= 2 || troubleScore >= 8;

  usefulScore = clamp(Math.round(usefulScore), 1, 10);
  troubleScore = clamp(Math.round(troubleScore), 1, 10);

  let mirror;
  if (usefulScore >= 7 && troubleScore <= 4 && !regretYes) {
    mirror = '可以发。你大概率不是在发泄，而是在表达。';
  } else if (troubleScore >= 7 || regretYes) {
    mirror = '先别急着发。你心里其实已经知道，这句话更像情绪，不像信息。';
  } else {
    mirror = '介于中间。不是不能说，但更适合晚一点、短一点、私下说。';
  }

  return {
    usefulScore,
    troubleScore,
    regretTomorrow: regretYes ? '是' : '否',
    mirror
  };
}

async function analyzeWithDeepSeek(input) {
  if (!deepSeekApiKey) {
    return null;
  }

  const response = await fetch(`${deepSeekBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${deepSeekApiKey}`
    },
    body: JSON.stringify({
      model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
      temperature: 0.2,
      response_format: {
        type: 'json_object'
      },
      messages: [
        {
          role: 'system',
          content: '你是一个“废话过滤器”。你的任务不是改写文案，而是像镜子一样判断一句话值不值得发出去。你必须只返回 JSON 对象，不要输出任何额外文字。JSON 格式必须是 {"usefulScore":1-10的整数,"troubleScore":1-10的整数,"regretTomorrow":"是或否","mirror":"一句简短中文判断"}。评分标准：1. usefulScore 评估信息量、建设性、是否有明确目的。2. troubleScore 评估是否容易引发冲突、误解、冒犯或公开场合风险。3. regretTomorrow 评估发出后第二天回看是否容易尴尬、后悔或觉得冲动。4. mirror 语气要像外部确认，不要改写原文，不要给多个建议，不要长篇解释。'
        },
        {
          role: 'user',
          content: `请判断这句话值不值得说：${input}`
        }
      ]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || 'DeepSeek 请求失败');
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;

  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('DeepSeek 返回内容为空');
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error('DeepSeek 返回的 JSON 无法解析');
  }

  return normalizeModelResult(parsed);
}

app.post('/api/analyze', async (req, res) => {
  const { text } = req.body || {};

  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ message: '请输入一句你准备发出去的话。' });
  }

  try {
    const modelResult = await analyzeWithDeepSeek(text.trim());

    if (modelResult) {
      return res.json({
        ...modelResult,
        source: 'deepseek'
      });
    }
  } catch (error) {
    console.error('DeepSeek analyze failed:', error.message);
  }

  return res.json({
    ...analyzeText(text),
    source: 'local'
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => {
  console.log(`Nonsense filter running at http://localhost:${port}`);
});
