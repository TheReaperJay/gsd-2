export interface StatusActivityRenderer {
	start(message: string): void;
	update(message: string): void;
	stop(): void;
}

export interface StatusActivityHandle {
	update(message?: string): void;
	stop(): void;
	isActive(): boolean;
}

export interface StatusActivityStartOptions {
	message?: string;
}

type StatusActivityEntry = {
	id: number;
	message?: string;
};

/**
 * Manages one shared status-activity lane (spinner + message) with handle-based ownership.
 * Multiple concurrent activities are supported; the most recently started active handle is shown.
 */
export class StatusActivityManager {
	private readonly activities: StatusActivityEntry[] = [];
	private nextId = 1;
	private rendererActive = false;
	private pendingMessage: string | undefined;
	private readonly renderer: StatusActivityRenderer;
	private readonly defaultMessage: () => string;

	constructor(renderer: StatusActivityRenderer, defaultMessage: () => string) {
		this.renderer = renderer;
		this.defaultMessage = defaultMessage;
	}

	start(options?: StatusActivityStartOptions): StatusActivityHandle {
		const activity: StatusActivityEntry = {
			id: this.nextId++,
			message: normalizeMessage(options?.message) ?? this.consumePendingMessage(),
		};
		this.activities.push(activity);
		this.render();

		return {
			update: (message?: string) => this.update(activity.id, message),
			stop: () => this.stop(activity.id),
			isActive: () => this.has(activity.id),
		};
	}

	async run<T>(operation: () => Promise<T>, options?: StatusActivityStartOptions): Promise<T> {
		const activity = this.start(options);
		try {
			return await operation();
		} finally {
			activity.stop();
		}
	}

	setWorkingMessage(message?: string): void {
		const active = this.getActive();
		if (!active) {
			this.pendingMessage = normalizeMessage(message);
			return;
		}
		this.update(active.id, message);
	}

	clear(): void {
		this.activities.length = 0;
		this.pendingMessage = undefined;
		if (this.rendererActive) {
			this.renderer.stop();
			this.rendererActive = false;
		}
	}

	private update(id: number, message?: string): void {
		const activity = this.activities.find((entry) => entry.id === id);
		if (!activity) return;
		activity.message = normalizeMessage(message);

		if (this.isTop(id)) {
			this.render();
		}
	}

	private stop(id: number): void {
		const index = this.activities.findIndex((entry) => entry.id === id);
		if (index === -1) return;

		const wasTop = index === this.activities.length - 1;
		this.activities.splice(index, 1);

		if (wasTop || this.activities.length === 0) {
			this.render();
		}
	}

	private render(): void {
		const active = this.getActive();
		if (!active) {
			if (this.rendererActive) {
				this.renderer.stop();
				this.rendererActive = false;
			}
			return;
		}

		const message = active.message ?? this.defaultMessage();
		if (!this.rendererActive) {
			this.renderer.start(message);
			this.rendererActive = true;
		} else {
			this.renderer.update(message);
		}
	}

	private getActive(): StatusActivityEntry | undefined {
		if (this.activities.length === 0) return undefined;
		return this.activities[this.activities.length - 1];
	}

	private consumePendingMessage(): string | undefined {
		const message = this.pendingMessage;
		this.pendingMessage = undefined;
		return message;
	}

	private isTop(id: number): boolean {
		const active = this.getActive();
		return active !== undefined && active.id === id;
	}

	private has(id: number): boolean {
		return this.activities.some((activity) => activity.id === id);
	}
}

function normalizeMessage(message?: string): string | undefined {
	if (message === undefined) return undefined;
	if (message.trim().length === 0) return undefined;
	return message;
}
