import { Inject, Module, type DynamicModule, type OnApplicationShutdown } from '@nestjs/common';
import type { Persistence } from '#src/capacity/adapters/out/postgres/db.js';

export const PERSISTENCE = Symbol('PERSISTENCE');

class PersistenceLifecycle implements OnApplicationShutdown {
  constructor(@Inject(PERSISTENCE) private readonly persistence: Persistence) {}

  /** Last step of Nest shutdown: intake is closed, so the pool can go. */
  async onApplicationShutdown(): Promise<void> {
    await this.persistence.close();
  }
}

/** Composition root. Capacity modules are added here by later lanes. */
@Module({})
export class AppModule {
  static register(persistence: Persistence): DynamicModule {
    return {
      module: AppModule,
      providers: [{ provide: PERSISTENCE, useValue: persistence }, PersistenceLifecycle],
      exports: [PERSISTENCE],
    };
  }
}
