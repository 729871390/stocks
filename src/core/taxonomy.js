// 一处定义、多处消费：渠道枚举、行业标签、行为标签、六栏目、角色、优先级、等级徽标
// 全部在此单点定义。管理页与筛选面板从同一定义渲染，禁止两边各自维护。

export const CHANNELS = ['rss', 'wechat', 'platform', 'x', 'youtube', 'podcast'];

export const CHANNEL_LABELS = {
  rss: 'RSS', wechat: '微信公众号', platform: '平台', x: 'X', youtube: 'YouTube', podcast: '播客',
};

// 条目行业标签（七选一，多至二，按事件主体公司行业归属）
export const INDUSTRY_TAGS = [
  'AI Labs', 'AI 应用与工具', '半导体', '云与大厂', '软件和互联网', '能源与基建', '其他',
];

// X 账号行业标签（十选一，与条目行业标签对齐 + 补充）
export const X_INDUSTRY_TAGS = [
  'AI Labs', 'AI 应用与工具', '半导体', '云与大厂', '软件和互联网', '能源与基建',
  '金融投资', '媒体资讯', '学术研究', '其他',
];

// 行为标签（十选一）
export const ACTION_TAGS = [
  '融资并购', '人员变动', '产品发布', '模型发布', '财报业绩',
  '政策监管', '算力基建', '研究进展', '观点评论', '行业新闻',
];

// 六栏目（信息流栏目 = 日报重要信号六模块，固定顺序）
export const CATEGORIES = [
  { key: 'model_labs', label: 'Model/Labs' },
  { key: 'compute_infra', label: '算力/Infra/半导体' },
  { key: 'software_app', label: '软件/Application' },
  { key: 'funding', label: '融资动向' },
  { key: 'people', label: '人员动态' },
  { key: 'research', label: '研究动态' },
];

export const ROLES = ['研究者', '创始人·高管', '投资人', '机构官号', 'KOL'];

export const PRIORITIES = [
  { key: 'P0', label: '核心' },
  { key: 'P1', label: '标准' },
  { key: 'P2', label: '观察' },
];

export const CONTENT_TYPES = ['article', 'tweet', 'video', 'podcast'];

// 五色等级徽标：实底三档值得读，描边两档低价值。全站同源引用。
export const GRADE_BADGES = {
  5: { color: '#b03a2e', fill: true, label: '5' },   // 砖红实底
  4: { color: '#ca7a2c', fill: true, label: '4' },   // 赭橙实底
  3: { color: '#2e7d4f', fill: true, label: '3' },   // 主绿实底
  2: { color: '#2c3e50', fill: false, label: '2' },  // 墨描边
  1: { color: '#b8bcc2', fill: false, label: '1' },  // 浅灰描边
};

// 空洞词黑名单（深读正文命中即重写）
export const HOLLOW_WORDS = ['值得关注', '意义重大', '影响深远', '不容忽视', '拭目以待', '引发热议'];

// 社媒互动数据禁令的正则复检（三重防线之二）
export const ENGAGEMENT_RE = /\d[\d,.万kKmM+]*\s*(次)?\s*(点赞|转发|评论|浏览|观看|播放|收藏|likes?|retweets?|reposts?|views?|comments?|bookmarks?)/;
