const WASI_SUCCESS = 0;
const WASI_EINVAL = 28;
const WASI_ENOSYS = 52;
const CLOCK_EVENT = 0;
const SUBSCRIPTION_SIZE = 48;
const EVENT_SIZE = 32;
const SUBSCRIPTION_CLOCK = 0;
const ABSOLUTE_CLOCK = 1;
const MAX_TIMER_MILLIS = 2_147_483_647;
const NANOS_PER_MILLI = 1000000n;
export class WasiClock {
    memory;
    nowNanos = BigInt(Date.now()) * NANOS_PER_MILLI;
    interruptPoll;
    constructor(memory) {
        this.memory = memory;
    }
    clockTimeGet = (clockId, _precision, resultPointer) => {
        if (clockId < 0 || clockId > 3) {
            return WASI_EINVAL;
        }
        this.syncWallClock();
        this.view().setBigUint64(resultPointer, this.nowNanos, true);
        return WASI_SUCCESS;
    };
    pollOneoff = async (subscriptionsPointer, eventsPointer, subscriptionCount, resultCountPointer) => {
        if (subscriptionCount <= 0) {
            return WASI_EINVAL;
        }
        const subscriptions = this.readClockSubscriptions(subscriptionsPointer, subscriptionCount);
        if (subscriptions.length === 0) {
            return WASI_ENOSYS;
        }
        const selected = subscriptions.reduce((left, right) => left.waitNanos <= right.waitNanos ? left : right);
        const waitMillis = Number((selected.waitNanos + NANOS_PER_MILLI - 1n) / NANOS_PER_MILLI);
        const boundedWait = Math.min(waitMillis, MAX_TIMER_MILLIS);
        const resolution = await new Promise((resolve) => {
            const timer = setTimeout(() => resolve("timer"), boundedWait);
            this.interruptPoll = () => {
                clearTimeout(timer);
                resolve("interrupt");
            };
        });
        this.interruptPoll = undefined;
        if (resolution === "timer") {
            this.nowNanos = selected.deadlineNanos;
            this.syncWallClock();
        }
        this.writeClockEvent(eventsPointer, selected.userdata);
        this.view().setUint32(resultCountPointer, 1, true);
        return WASI_SUCCESS;
    };
    interrupt() {
        this.interruptPoll?.();
    }
    advanceMillis(milliseconds) {
        if (Number.isFinite(milliseconds) && milliseconds > 0) {
            this.nowNanos += BigInt(Math.ceil(milliseconds)) * NANOS_PER_MILLI;
        }
        this.syncWallClock();
    }
    syncWallTime() {
        this.syncWallClock();
    }
    readClockSubscriptions(pointer, count) {
        const view = this.view();
        const subscriptions = [];
        for (let index = 0; index < count; index += 1) {
            const offset = pointer + index * SUBSCRIPTION_SIZE;
            const type = view.getUint8(offset + 8);
            if (type !== SUBSCRIPTION_CLOCK) {
                continue;
            }
            const userdata = view.getBigUint64(offset, true);
            const clockId = view.getUint32(offset + 16, true);
            const timeout = view.getBigUint64(offset + 24, true);
            const flags = view.getUint16(offset + 40, true);
            const deadlineNanos = (flags & ABSOLUTE_CLOCK) === 0 ? this.nowNanos + timeout : timeout;
            subscriptions.push({
                userdata,
                clockId,
                deadlineNanos,
                waitNanos: deadlineNanos > this.nowNanos ? deadlineNanos - this.nowNanos : 0n,
            });
        }
        return subscriptions;
    }
    writeClockEvent(pointer, userdata) {
        const bytes = new Uint8Array(this.memory().buffer, pointer, EVENT_SIZE);
        bytes.fill(0);
        const view = this.view();
        view.setBigUint64(pointer, userdata, true);
        view.setUint16(pointer + 8, WASI_SUCCESS, true);
        view.setUint8(pointer + 10, CLOCK_EVENT);
    }
    syncWallClock() {
        const wallClock = BigInt(Date.now()) * NANOS_PER_MILLI;
        if (wallClock > this.nowNanos) {
            this.nowNanos = wallClock;
        }
    }
    view() {
        return new DataView(this.memory().buffer);
    }
}
