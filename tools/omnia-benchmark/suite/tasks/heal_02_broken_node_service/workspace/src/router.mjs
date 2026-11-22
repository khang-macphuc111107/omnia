export class RouteEngine {
  constructor(config) {
    this.defaultChannel = config.default_channel || 'general';
    this.routes = config.routes || {};
  }

  resolve(event) {
    const type = event && typeof event.type === 'string' ? event.type : '';
    const match = this.routes[type];
    if (match) {
      return {
        channel: match.channel,
        priority: match.priority,
        tag: match.tag,
      };
    }
    return {
      channel: this.defaultChannel,
      priority: 'normal',
      tag: 'GENERAL',
    };
  }
}
