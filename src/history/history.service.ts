import {
  AmqpConnection,
  RabbitSubscribe,
  requeueErrorHandler,
} from '@golevelup/nestjs-rabbitmq';
import { Injectable } from '@nestjs/common';
import { InjectConnection, InjectRepository } from '@nestjs/typeorm';
import {
  IPaginationOptions,
  paginate,
  Pagination,
} from 'nestjs-typeorm-paginate';
import {
  Between,
  Connection,
  FindConditions,
  LessThanOrEqual,
  MoreThanOrEqual,
  Repository,
} from 'typeorm';
import { History } from './entities/history.entity';
import { Price } from './interfaces/price.interface';

@Injectable()
export class HistoryService {
  constructor(
    @InjectRepository(History)
    private readonly repository: Repository<History>,
    private readonly amqpConnection: AmqpConnection,
    @InjectConnection()
    private readonly connection: Connection,
  ) {}

  @RabbitSubscribe({
    exchange: 'bptf-price.updated',
    routingKey: '*',
    queue: 'saveBptfPriceInHistory',
    queueOptions: {
      arguments: {
        'x-queue-type': 'quorum',
      },
    },
    errorHandler: requeueErrorHandler,
  })
  private async handlePrice(price: Price): Promise<void> {
    const history = await this.connection.transaction(
      async (transactionalEntityManager) => {
        // Find most recent price for this item
        const mostRecent = await transactionalEntityManager.findOne(History, {
          order: {
            createdAt: 'DESC',
          },
          where: {
            sku: price.sku,
          },
        });

        if (mostRecent) {
          // Found previous price
          if (
            mostRecent.createdAt.getTime() >=
            new Date(price.updatedAt).getTime()
          ) {
            // Current price in database is older than price from event
            return;
          } else if (
            mostRecent.sellKeys === price.sellKeys &&
            mostRecent.sellHalfScrap === price.sellHalfScrap &&
            mostRecent.buyKeys === price.buyKeys &&
            mostRecent.buyHalfScrap === price.buyHalfScrap
          ) {
            // Price in database is same as price from event
            return;
          }
        }

        // Price updated, save new price to database

        const history = transactionalEntityManager.create(History, {
          sku: price.sku,
          buyHalfScrap: price.buyHalfScrap,
          buyKeys: price.buyKeys,
          sellHalfScrap: price.sellHalfScrap,
          sellKeys: price.sellKeys,
          createdAt: price.updatedAt,
        });

        // Save the price
        await transactionalEntityManager.save(history);

        return history;
      },
    );

    if (history) {
      // Publish new price to rabbitmq
      await this.amqpConnection.publish(
        'bptf-price-history.created',
        '*',
        history,
      );
    }
  }

  paginate(
    sku: string,
    options: IPaginationOptions,
    order: 'ASC' | 'DESC',
    from?: Date,
    to?: Date,
  ): Promise<Pagination<History>> {
    const where: FindConditions<History> = {
      sku,
    };

    if (from && to) {
      where.createdAt = Between(from, to);
    } else if (from) {
      where.createdAt =
        order === 'ASC' ? MoreThanOrEqual(from) : LessThanOrEqual(from);
    } else if (to) {
      where.createdAt =
        order === 'ASC' ? LessThanOrEqual(to) : MoreThanOrEqual(to);
    }

    return paginate<History>(this.repository, options, {
      order: {
        createdAt: order,
      },
      where,
    });
  }

  /**
   * Get price history of an item using an interval
   * @param sku SKU of the item
   * @param interval Interval to use in milliseconds
   * @param options Pagination options
   * @param order Ordering of prices by time
   * @param from Timestamp to start getting data from
   * @param to Timestamp to start getting data to
   * @returns Paginated price history using interval
   */
  async intervalPaginated(
    sku: string,
    interval: number,
    from?: Date,
    to?: Date,
  ): Promise<History[]> {
    const where: FindConditions<History> = {
      sku,
    };

    if (from && to) {
      where.createdAt = Between(from, to);
    } else if (from) {
      where.createdAt = MoreThanOrEqual(from);
    } else if (to) {
      where.createdAt = LessThanOrEqual(to);
    }

    const queryBuilder = this.repository.createQueryBuilder('a');

    // FIXME: Potential SQL injection
    // Can't use parameters because then distinct on doesn't match order by

    queryBuilder
      .select([
        'a.sku',
        'a.buyHalfScrap',
        'a.buyKeys',
        'a.sellHalfScrap',
        'a.sellKeys',
        'a.createdAt',
      ])
      .distinctOn([
        'FLOOR(EXTRACT(EPOCH FROM a."createdAt") * 1000 / ' + interval + ')',
      ])
      .where(where)
      .orderBy(
        'FLOOR(EXTRACT(EPOCH FROM a."createdAt") * 1000 / ' + interval + ')',
        'ASC',
      )
      .addOrderBy('a."createdAt"', 'DESC');

    const result = await queryBuilder.getMany();

    // Loop through all items and convert date to be multiple of interval
    result.forEach((v) => {
      v.createdAt = this.getDateFromInterval(
        this.getIntervalNumber(v.createdAt, interval),
        interval,
      );
    });

    // Go through result and populate missing intervals with previous price

    // If to and or from is defined, then we want to make sure the intervals
    // match that too

    if (from && result.length > 0) {
      const fromInterval = this.getIntervalNumber(from, interval);
      if (
        this.getIntervalNumber(result[0].createdAt, interval) !== fromInterval
      ) {
        // From is specified and oldest price is not on same interval as from
        // so we need to get the most recent price before from and add it to the
        // result

        // Get most recent price before from
        const before = await this.repository.findOne({
          where: {
            sku,
            createdAt: LessThanOrEqual(from),
          },
          order: {
            createdAt: 'ASC',
          },
        });

        if (before !== undefined) {
          // Set correct date
          before.createdAt = this.getDateFromInterval(fromInterval, interval);

          // Insert price at correct location
          result.splice(0, 0, before);
        }
      }
    }

    if (to && result.length > 0) {
      // Same as from, just opposite and with to instead of from
      const toInterval = this.getIntervalNumber(to, interval) - 1;

      if (
        this.getIntervalNumber(
          result[result.length - 1].createdAt,
          interval,
        ) !== toInterval
      ) {
        const newestPrice = await this.repository.findOne({
          where: {
            sku,
            createdAt: MoreThanOrEqual(to),
          },
          order: {
            createdAt: 'DESC',
          },
        });

        if (newestPrice !== undefined) {
          // There is a newer price, we want to populate missing intervals up
          // to "to"

          const before = result[result.length - 1];

          if (before !== undefined) {
            // Set correct date
            before.createdAt = this.getDateFromInterval(toInterval, interval);

            // Insert price at correct location
            result.splice(result.length, 0, before);
          }
        }
      }
    }

    if (result.length > 1) {
      // Get most recent interval number
      let prevInterval = this.getIntervalNumber(
        result[result.length - 1].createdAt,
        interval,
      );

      // Loop through all items in result
      for (let i = result.length - 1; i--; ) {
        const item = result[i];

        const currInterval = this.getIntervalNumber(item.createdAt, interval);

        const difference = Math.abs(prevInterval - currInterval);

        // Add new intervals to array

        for (let j = 0; j < difference - 1; j++) {
          const history = Object.assign({}, result[i + 1]);
          history.createdAt = this.getDateFromInterval(
            currInterval + j + 1,
            interval,
          );
          result.splice(i + j + 1, 0, history);
        }

        prevInterval = currInterval;
      }
    }

    return result;
  }

  /**
   * Gets the interval number from a date and interval
   * @param date Date to get interval from
   * @param interval The interval time to use, in milliseconds
   * @returns Interval number
   */
  private getIntervalNumber(date: Date, interval: number): number {
    return Math.floor(date.getTime() / interval);
  }

  /**
   * Gets a date from an interval and interval number
   * @param intervalNumber The interval number
   * @param interval The interval time to use, in milliseconds
   * @returns
   */
  private getDateFromInterval(intervalNumber: number, interval: number): Date {
    return new Date(interval * intervalNumber);
  }
}
