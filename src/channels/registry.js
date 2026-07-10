// 渠道适配器注册表。每个适配器实现：
//   discover(source) -> raw_item[]              发现新内容（拉 feed / 批量搜索）
//   fetch(source, raw) -> normalized_item       归一化统一条目结构
//   onInserted?(db, source, item)               入库后钩子（转写排队、二次处理）
//   detect?(input) -> {identifier, name?}|null  批量添加时的自动识别
// 新增渠道 = 一个适配器 + 此表一行 + 添加表单一种类型，不改任何下游代码。

import * as rss from './rss.js';
import * as wechat from './wechat.js';
import * as platform from './platform.js';
import * as x from './x.js';
import * as youtube from './youtube.js';
import * as podcast from './podcast.js';

export const ADAPTERS = { rss, wechat, platform, x, youtube, podcast };

export function getAdapter(channel) {
  const a = ADAPTERS[channel];
  if (!a) throw new Error(`unknown channel: ${channel}`);
  return a;
}

export function isValidChannel(channel) {
  return Object.hasOwn(ADAPTERS, channel);
}
