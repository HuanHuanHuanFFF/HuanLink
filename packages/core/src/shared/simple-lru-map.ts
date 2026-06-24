// 基于 Map 插入顺序实现的轻量级内存 LRU 缓存。
export class SimpleLruMap<K, V> {
    private readonly map = new Map<K, V>();

    // 在构造时校验缓存容量是否合法。
    constructor(private readonly maxSize: number) {
        if (!Number.isInteger(maxSize) || maxSize <= 0) {
            throw new Error("maxSize must be a positive integer");
        }
    }

    // 读取并刷新条目，让最近访问的数据留在缓存里。
    get(key: K): V | undefined {
        if (!this.map.has(key)) {
            return undefined;
        }

        const value = this.map.get(key)!;

        this.map.delete(key);
        this.map.set(key, value);

        return value;
    }

    // 写入或刷新条目；超出容量时淘汰最久未使用的数据。
    set(key: K, value: V): void {
        if (this.map.has(key)) {
            this.map.delete(key);
        }

        this.map.set(key, value);

        if (this.map.size > this.maxSize) {
            const oldest = this.map.keys().next();

            if (!oldest.done) {
                this.map.delete(oldest.value);
            }
        }
    }

    // 显式删除一个缓存条目。
    delete(key: K): void {
        this.map.delete(key);
    }

    // 判断某个条目当前是否在缓存中。
    has(key: K): boolean {
        return this.map.has(key);
    }

    // 返回当前缓存条目数。
    get size(): number {
        return this.map.size;
    }

    // 清空所有缓存条目。
    clear(): void {
        this.map.clear();
    }
}
