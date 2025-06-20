import { OperationNodeSource } from '../operation-node/operation-node-source.js'
import { CompiledQuery } from '../query-compiler/compiled-query.js'
import {
  JoinCallbackExpression,
  JoinReferenceExpression,
  parseJoin,
} from '../parser/join-parser.js'
import {
  From,
  FromTables,
  parseTableExpressionOrList,
  TableExpression,
  TableExpressionOrList,
} from '../parser/table-parser.js'
import {
  parseSelectArg,
  parseSelectAll,
  SelectExpression,
  SelectArg,
  SelectCallback,
} from '../parser/select-parser.js'
import {
  ReturningAllRow,
  ReturningCallbackRow,
  ReturningRow,
} from '../parser/returning-parser.js'
import { ReferenceExpression } from '../parser/reference-parser.js'
import { QueryNode } from '../operation-node/query-node.js'
import {
  DrainOuterGeneric,
  NarrowPartial,
  Nullable,
  ShallowRecord,
  SimplifyResult,
  SimplifySingleResult,
  SqlBool,
} from '../util/type-utils.js'
import { Compilable } from '../util/compilable.js'
import { QueryExecutor } from '../query-executor/query-executor.js'
import { QueryId } from '../util/query-id.js'
import { freeze } from '../util/object-utils.js'
import { KyselyPlugin } from '../plugin/kysely-plugin.js'
import { WhereInterface } from './where-interface.js'
import { MultiTableReturningInterface } from './returning-interface.js'
import {
  isNoResultErrorConstructor,
  NoResultError,
  NoResultErrorConstructor,
} from './no-result-error.js'
import { DeleteResult } from './delete-result.js'
import { DeleteQueryNode } from '../operation-node/delete-query-node.js'
import { LimitNode } from '../operation-node/limit-node.js'
import {
  OrderByExpression,
  parseOrderBy,
  OrderByModifiers,
  DirectedOrderByStringReference,
} from '../parser/order-by-parser.js'
import { Explainable, ExplainFormat } from '../util/explainable.js'
import { AliasedExpression, Expression } from '../expression/expression.js'
import {
  ComparisonOperatorExpression,
  OperandValueExpressionOrList,
  parseValueBinaryOperationOrExpression,
  parseReferentialBinaryOperation,
} from '../parser/binary-operation-parser.js'
import { KyselyTypeError } from '../util/type-error.js'
import { Streamable } from '../util/streamable.js'
import { ExpressionOrFactory } from '../parser/expression-parser.js'
import {
  ValueExpression,
  parseValueExpression,
} from '../parser/value-parser.js'
import { parseTop } from '../parser/top-parser.js'
import {
  OutputCallback,
  OutputExpression,
  OutputInterface,
  SelectExpressionFromOutputCallback,
  SelectExpressionFromOutputExpression,
} from './output-interface.js'
import { JoinType } from '../operation-node/join-node.js'
import { OrderByInterface } from './order-by-interface.js'

export class DeleteQueryBuilder<DB, TB extends keyof DB, O>
  implements
    WhereInterface<DB, TB>,
    MultiTableReturningInterface<DB, TB, O>,
    OutputInterface<DB, TB, O, 'deleted'>,
    OrderByInterface<DB, TB, {}>,
    OperationNodeSource,
    Compilable<O>,
    Explainable,
    Streamable<O>
{
  readonly #props: DeleteQueryBuilderProps

  constructor(props: DeleteQueryBuilderProps) {
    this.#props = freeze(props)
  }

  where<
    RE extends ReferenceExpression<DB, TB>,
    VE extends OperandValueExpressionOrList<DB, TB, RE>,
  >(
    lhs: RE,
    op: ComparisonOperatorExpression,
    rhs: VE,
  ): DeleteQueryBuilder<DB, TB, O>

  where<E extends ExpressionOrFactory<DB, TB, SqlBool>>(
    expression: E,
  ): DeleteQueryBuilder<DB, TB, O>

  where(...args: any[]): any {
    return new DeleteQueryBuilder({
      ...this.#props,
      queryNode: QueryNode.cloneWithWhere(
        this.#props.queryNode,
        parseValueBinaryOperationOrExpression(args),
      ),
    })
  }

  whereRef<
    LRE extends ReferenceExpression<DB, TB>,
    RRE extends ReferenceExpression<DB, TB>,
  >(
    lhs: LRE,
    op: ComparisonOperatorExpression,
    rhs: RRE,
  ): DeleteQueryBuilder<DB, TB, O> {
    return new DeleteQueryBuilder({
      ...this.#props,
      queryNode: QueryNode.cloneWithWhere(
        this.#props.queryNode,
        parseReferentialBinaryOperation(lhs, op, rhs),
      ),
    })
  }

  clearWhere(): DeleteQueryBuilder<DB, TB, O> {
    return new DeleteQueryBuilder<DB, TB, O>({
      ...this.#props,
      queryNode: QueryNode.cloneWithoutWhere(this.#props.queryNode),
    })
  }

  /**
   * Changes a `delete from` query into a `delete top from` query.
   *
   * `top` clause is only supported by some dialects like MS SQL Server.
   *
   * ### Examples
   *
   * Delete the first 5 rows:
   *
   * ```ts
   * await db
   *   .deleteFrom('person')
   *   .top(5)
   *   .where('age', '>', 18)
   *   .executeTakeFirstOrThrow()
   * ```
   *
   * The generated SQL (MS SQL Server):
   *
   * ```sql
   * delete top(5) from "person" where "age" > @1
   * ```
   *
   * Delete the first 50% of rows:
   *
   * ```ts
   * await db
   *   .deleteFrom('person')
   *   .top(50, 'percent')
   *   .where('age', '>', 18)
   *   .executeTakeFirstOrThrow()
   * ```
   *
   * The generated SQL (MS SQL Server):
   *
   * ```sql
   * delete top(50) percent from "person" where "age" > @1
   * ```
   */
  top(
    expression: number | bigint,
    modifiers?: 'percent',
  ): DeleteQueryBuilder<DB, TB, O> {
    return new DeleteQueryBuilder({
      ...this.#props,
      queryNode: QueryNode.cloneWithTop(
        this.#props.queryNode,
        parseTop(expression, modifiers),
      ),
    })
  }

  /**
   * Adds a `using` clause to the query.
   *
   * This clause allows adding additional tables to the query for filtering/returning
   * only. Usually a non-standard syntactic-sugar alternative to a `where` with a sub-query.
   *
   * ### Examples:
   *
   * ```ts
   * await db
   *   .deleteFrom('pet')
   *   .using('person')
   *   .whereRef('pet.owner_id', '=', 'person.id')
   *   .where('person.first_name', '=', 'Bob')
   *   .executeTakeFirstOrThrow()
   * ```
   *
   * The generated SQL (PostgreSQL):
   *
   * ```sql
   * delete from "pet"
   * using "person"
   * where "pet"."owner_id" = "person"."id"
   *   and "person"."first_name" = $1
   * ```
   *
   * On supported databases such as MySQL, this clause allows using joins, but requires
   * at least one of the tables after the `from` keyword to be also named after
   * the `using` keyword. See also {@link innerJoin}, {@link leftJoin}, {@link rightJoin}
   * and {@link fullJoin}.
   *
   * ```ts
   * await db
   *   .deleteFrom('pet')
   *   .using('pet')
   *   .leftJoin('person', 'person.id', 'pet.owner_id')
   *   .where('person.first_name', '=', 'Bob')
   *   .executeTakeFirstOrThrow()
   * ```
   *
   * The generated SQL (MySQL):
   *
   * ```sql
   * delete from `pet`
   * using `pet`
   * left join `person` on `person`.`id` = `pet`.`owner_id`
   * where `person`.`first_name` = ?
   * ```
   *
   * You can also chain multiple invocations of this method, or pass an array to
   * a single invocation to name multiple tables.
   *
   * ```ts
   * await db
   *   .deleteFrom('toy')
   *   .using(['pet', 'person'])
   *   .whereRef('toy.pet_id', '=', 'pet.id')
   *   .whereRef('pet.owner_id', '=', 'person.id')
   *   .where('person.first_name', '=', 'Bob')
   *   .returning('pet.name')
   *   .executeTakeFirstOrThrow()
   * ```
   *
   * The generated SQL (PostgreSQL):
   *
   * ```sql
   * delete from "toy"
   * using "pet", "person"
   * where "toy"."pet_id" = "pet"."id"
   *   and "pet"."owner_id" = "person"."id"
   *   and "person"."first_name" = $1
   * returning "pet"."name"
   * ```
   */
  using<TE extends TableExpression<DB, keyof DB>>(
    tables: TE[],
  ): DeleteQueryBuilder<From<DB, TE>, FromTables<DB, TB, TE>, O>

  using<TE extends TableExpression<DB, keyof DB>>(
    table: TE,
  ): DeleteQueryBuilder<From<DB, TE>, FromTables<DB, TB, TE>, O>

  using(tables: TableExpressionOrList<any, any>): any {
    return new DeleteQueryBuilder({
      ...this.#props,
      queryNode: DeleteQueryNode.cloneWithUsing(
        this.#props.queryNode,
        parseTableExpressionOrList(tables),
      ),
    })
  }

  /**
   * Joins another table to the query using an inner join.
   *
   * ### Examples
   *
   * Simple usage by providing a table name and two columns to join:
   *
   * ```ts
   * const result = await db
   *   .selectFrom('person')
   *   .innerJoin('pet', 'pet.owner_id', 'person.id')
   *   // `select` needs to come after the call to `innerJoin` so
   *   // that you can select from the joined table.
   *   .select(['person.id', 'pet.name'])
   *   .execute()
   *
   * result[0].id
   * result[0].name
   * ```
   *
   * The generated SQL (PostgreSQL):
   *
   * ```sql
   * select "person"."id", "pet"."name"
   * from "person"
   * inner join "pet"
   * on "pet"."owner_id" = "person"."id"
   * ```
   *
   * You can give an alias for the joined table like this:
   *
   * ```ts
   * await db.selectFrom('person')
   *   .innerJoin('pet as p', 'p.owner_id', 'person.id')
   *   .where('p.name', '=', 'Doggo')
   *   .selectAll()
   *   .execute()
   * ```
   *
   * The generated SQL (PostgreSQL):
   *
   * ```sql
   * select *
   * from "person"
   * inner join "pet" as "p"
   * on "p"."owner_id" = "person"."id"
   * where "p".name" = $1
   * ```
   *
   * You can provide a function as the second argument to get a join
   * builder for creating more complex joins. The join builder has a
   * bunch of `on*` methods for building the `on` clause of the join.
   * There's basically an equivalent for every `where` method
   * (`on`, `onRef`, `onExists` etc.). You can do all the same things
   * with the `on` method that you can with the corresponding `where`
   * method. See the `where` method documentation for more examples.
   *
   * ```ts
   * await db.selectFrom('person')
   *   .innerJoin(
   *     'pet',
   *     (join) => join
   *       .onRef('pet.owner_id', '=', 'person.id')
   *       .on('pet.name', '=', 'Doggo')
   *   )
   *   .selectAll()
   *   .execute()
   * ```
   *
   * The generated SQL (PostgreSQL):
   *
   * ```sql
   * select *
   * from "person"
   * inner join "pet"
   * on "pet"."owner_id" = "person"."id"
   * and "pet"."name" = $1
   * ```
   *
   * You can join a subquery by providing a select query (or a callback)
   * as the first argument:
   *
   * ```ts
   * await db.selectFrom('person')
   *   .innerJoin(
   *     db.selectFrom('pet')
   *       .select(['owner_id', 'name'])
   *       .where('name', '=', 'Doggo')
   *       .as('doggos'),
   *     'doggos.owner_id',
   *     'person.id',
   *   )
   *   .selectAll()
   *   .execute()
   * ```
   *
   * The generated SQL (PostgreSQL):
   *
   * ```sql
   * select *
   * from "person"
   * inner join (
   *   select "owner_id", "name"
   *   from "pet"
   *   where "name" = $1
   * ) as "doggos"
   * on "doggos"."owner_id" = "person"."id"
   * ```
   */
  innerJoin<
    TE extends TableExpression<DB, TB>,
    K1 extends JoinReferenceExpression<DB, TB, TE>,
    K2 extends JoinReferenceExpression<DB, TB, TE>,
  >(table: TE, k1: K1, k2: K2): DeleteQueryBuilderWithInnerJoin<DB, TB, O, TE>

  innerJoin<
    TE extends TableExpression<DB, TB>,
    FN extends JoinCallbackExpression<DB, TB, TE>,
  >(table: TE, callback: FN): DeleteQueryBuilderWithInnerJoin<DB, TB, O, TE>

  innerJoin(...args: any): any {
    return this.#join('InnerJoin', args)
  }

  /**
   * Just like {@link innerJoin} but adds a left join instead of an inner join.
   */
  leftJoin<
    TE extends TableExpression<DB, TB>,
    K1 extends JoinReferenceExpression<DB, TB, TE>,
    K2 extends JoinReferenceExpression<DB, TB, TE>,
  >(table: TE, k1: K1, k2: K2): DeleteQueryBuilderWithLeftJoin<DB, TB, O, TE>

  leftJoin<
    TE extends TableExpression<DB, TB>,
    FN extends JoinCallbackExpression<DB, TB, TE>,
  >(table: TE, callback: FN): DeleteQueryBuilderWithLeftJoin<DB, TB, O, TE>

  leftJoin(...args: any): any {
    return this.#join('LeftJoin', args)
  }

  /**
   * Just like {@link innerJoin} but adds a right join instead of an inner join.
   */
  rightJoin<
    TE extends TableExpression<DB, TB>,
    K1 extends JoinReferenceExpression<DB, TB, TE>,
    K2 extends JoinReferenceExpression<DB, TB, TE>,
  >(table: TE, k1: K1, k2: K2): DeleteQueryBuilderWithRightJoin<DB, TB, O, TE>

  rightJoin<
    TE extends TableExpression<DB, TB>,
    FN extends JoinCallbackExpression<DB, TB, TE>,
  >(table: TE, callback: FN): DeleteQueryBuilderWithRightJoin<DB, TB, O, TE>

  rightJoin(...args: any): any {
    return this.#join('RightJoin', args)
  }

  /**
   * Just like {@link innerJoin} but adds a full join instead of an inner join.
   */
  fullJoin<
    TE extends TableExpression<DB, TB>,
    K1 extends JoinReferenceExpression<DB, TB, TE>,
    K2 extends JoinReferenceExpression<DB, TB, TE>,
  >(table: TE, k1: K1, k2: K2): DeleteQueryBuilderWithFullJoin<DB, TB, O, TE>

  fullJoin<
    TE extends TableExpression<DB, TB>,
    FN extends JoinCallbackExpression<DB, TB, TE>,
  >(table: TE, callback: FN): DeleteQueryBuilderWithFullJoin<DB, TB, O, TE>

  fullJoin(...args: any): any {
    return this.#join('FullJoin', args)
  }

  #join(joinType: JoinType, args: any[]): any {
    return new DeleteQueryBuilder({
      ...this.#props,
      queryNode: QueryNode.cloneWithJoin(
        this.#props.queryNode,
        parseJoin(joinType, args),
      ),
    })
  }

  returning<SE extends SelectExpression<DB, TB>>(
    selections: ReadonlyArray<SE>,
  ): DeleteQueryBuilder<DB, TB, ReturningRow<DB, TB, O, SE>>

  returning<CB extends SelectCallback<DB, TB>>(
    callback: CB,
  ): DeleteQueryBuilder<DB, TB, ReturningCallbackRow<DB, TB, O, CB>>

  returning<SE extends SelectExpression<DB, TB>>(
    selection: SE,
  ): DeleteQueryBuilder<DB, TB, ReturningRow<DB, TB, O, SE>>

  returning<SE extends SelectExpression<DB, TB>>(
    selection: SelectArg<DB, TB, SE>,
  ): DeleteQueryBuilder<DB, TB, ReturningRow<DB, TB, O, SE>> {
    return new DeleteQueryBuilder({
      ...this.#props,
      queryNode: QueryNode.cloneWithReturning(
        this.#props.queryNode,
        parseSelectArg(selection),
      ),
    })
  }

  /**
   * Adds `returning *` or `returning table.*` clause to the query.
   *
   * ### Examples
   *
   * Return all columns.
   *
   * ```ts
   * const pets = await db
   *   .deleteFrom('pet')
   *   .returningAll()
   *   .execute()
   * ```
   *
   * The generated SQL (PostgreSQL)
   *
   * ```sql
   * delete from "pet" returning *
   * ```
   *
   * Return all columns from all tables
   *
   * ```ts
   * const result = await db
   *   .deleteFrom('toy')
   *   .using(['pet', 'person'])
   *   .whereRef('toy.pet_id', '=', 'pet.id')
   *   .whereRef('pet.owner_id', '=', 'person.id')
   *   .where('person.first_name', '=', 'Zoro')
   *   .returningAll()
   *   .execute()
   * ```
   *
   * The generated SQL (PostgreSQL)
   *
   * ```sql
   * delete from "toy"
   * using "pet", "person"
   * where "toy"."pet_id" = "pet"."id"
   * and "pet"."owner_id" = "person"."id"
   * and "person"."first_name" = $1
   * returning *
   * ```
   *
   * Return all columns from a single table.
   *
   * ```ts
   * const result = await db
   *   .deleteFrom('toy')
   *   .using(['pet', 'person'])
   *   .whereRef('toy.pet_id', '=', 'pet.id')
   *   .whereRef('pet.owner_id', '=', 'person.id')
   *   .where('person.first_name', '=', 'Itachi')
   *   .returningAll('pet')
   *   .execute()
   * ```
   *
   * The generated SQL (PostgreSQL)
   *
   * ```sql
   * delete from "toy"
   * using "pet", "person"
   * where "toy"."pet_id" = "pet"."id"
   * and "pet"."owner_id" = "person"."id"
   * and "person"."first_name" = $1
   * returning "pet".*
   * ```
   *
   * Return all columns from multiple tables.
   *
   * ```ts
   * const result = await db
   *   .deleteFrom('toy')
   *   .using(['pet', 'person'])
   *   .whereRef('toy.pet_id', '=', 'pet.id')
   *   .whereRef('pet.owner_id', '=', 'person.id')
   *   .where('person.first_name', '=', 'Luffy')
   *   .returningAll(['toy', 'pet'])
   *   .execute()
   * ```
   *
   * The generated SQL (PostgreSQL)
   *
   * ```sql
   * delete from "toy"
   * using "pet", "person"
   * where "toy"."pet_id" = "pet"."id"
   * and "pet"."owner_id" = "person"."id"
   * and "person"."first_name" = $1
   * returning "toy".*, "pet".*
   * ```
   */
  returningAll<T extends TB>(
    tables: ReadonlyArray<T>,
  ): DeleteQueryBuilder<DB, TB, ReturningAllRow<DB, T, O>>

  returningAll<T extends TB>(
    table: T,
  ): DeleteQueryBuilder<DB, TB, ReturningAllRow<DB, T, O>>

  returningAll(): DeleteQueryBuilder<DB, TB, ReturningAllRow<DB, TB, O>>

  returningAll(table?: any): any {
    return new DeleteQueryBuilder({
      ...this.#props,
      queryNode: QueryNode.cloneWithReturning(
        this.#props.queryNode,
        parseSelectAll(table),
      ),
    })
  }

  output<OE extends OutputExpression<DB, TB, 'deleted'>>(
    selections: readonly OE[],
  ): DeleteQueryBuilder<
    DB,
    TB,
    ReturningRow<DB, TB, O, SelectExpressionFromOutputExpression<OE>>
  >

  output<CB extends OutputCallback<DB, TB, 'deleted'>>(
    callback: CB,
  ): DeleteQueryBuilder<
    DB,
    TB,
    ReturningRow<DB, TB, O, SelectExpressionFromOutputCallback<CB>>
  >

  output<OE extends OutputExpression<DB, TB, 'deleted'>>(
    selection: OE,
  ): DeleteQueryBuilder<
    DB,
    TB,
    ReturningRow<DB, TB, O, SelectExpressionFromOutputExpression<OE>>
  >

  output(args: any): any {
    return new DeleteQueryBuilder({
      ...this.#props,
      queryNode: QueryNode.cloneWithOutput(
        this.#props.queryNode,
        parseSelectArg(args),
      ),
    })
  }

  outputAll(
    table: 'deleted',
  ): DeleteQueryBuilder<DB, TB, ReturningAllRow<DB, TB, O>> {
    return new DeleteQueryBuilder({
      ...this.#props,
      queryNode: QueryNode.cloneWithOutput(
        this.#props.queryNode,
        parseSelectAll(table),
      ),
    })
  }

  /**
   * Clears all `returning` clauses from the query.
   *
   * ### Examples
   *
   * ```ts
   * await db.deleteFrom('pet')
   *   .returningAll()
   *   .where('name', '=', 'Max')
   *   .clearReturning()
   *   .execute()
   * ```
   *
   * The generated SQL(PostgreSQL):
   *
   * ```sql
   * delete from "pet" where "name" = "Max"
   * ```
   */
  clearReturning(): DeleteQueryBuilder<DB, TB, DeleteResult> {
    return new DeleteQueryBuilder({
      ...this.#props,
      queryNode: QueryNode.cloneWithoutReturning(this.#props.queryNode),
    })
  }

  /**
   * Clears the `limit` clause from the query.
   *
   * ### Examples
   *
   * ```ts
   * await db.deleteFrom('pet')
   *   .returningAll()
   *   .where('name', '=', 'Max')
   *   .limit(5)
   *   .clearLimit()
   *   .execute()
   * ```
   *
   * The generated SQL(PostgreSQL):
   *
   * ```sql
   * delete from "pet" where "name" = "Max" returning *
   * ```
   */
  clearLimit(): DeleteQueryBuilder<DB, TB, O> {
    return new DeleteQueryBuilder<DB, TB, O>({
      ...this.#props,
      queryNode: DeleteQueryNode.cloneWithoutLimit(this.#props.queryNode),
    })
  }

  /**
   * @description This is only supported by some dialects like MySQL or SQLite with `SQLITE_ENABLE_UPDATE_DELETE_LIMIT`.
   */
  orderBy<OE extends OrderByExpression<DB, TB, {}>>(
    expr: OE,
    modifiers?: OrderByModifiers,
  ): DeleteQueryBuilder<DB, TB, O>

  // TODO: remove in v0.29
  /**
   * @description This is only supported by some dialects like MySQL or SQLite with `SQLITE_ENABLE_UPDATE_DELETE_LIMIT`.
   * @deprecated It does ~2-2.6x more compile-time instantiations compared to multiple chained `orderBy(expr, modifiers?)` calls (in `order by` clauses with reasonable item counts), and has broken autocompletion.
   */
  orderBy<
    OE extends
      | OrderByExpression<DB, TB, {}>
      | DirectedOrderByStringReference<DB, TB, {}>,
  >(exprs: ReadonlyArray<OE>): DeleteQueryBuilder<DB, TB, O>

  // TODO: remove in v0.29
  /**
   * @description This is only supported by some dialects like MySQL or SQLite with `SQLITE_ENABLE_UPDATE_DELETE_LIMIT`.
   * @deprecated It does ~2.9x more compile-time instantiations compared to a `orderBy(expr, direction)` call.
   */
  orderBy<OE extends DirectedOrderByStringReference<DB, TB, {}>>(
    expr: OE,
  ): DeleteQueryBuilder<DB, TB, O>

  // TODO: remove in v0.29
  /**
   * @description This is only supported by some dialects like MySQL or SQLite with `SQLITE_ENABLE_UPDATE_DELETE_LIMIT`.
   * @deprecated Use `orderBy(expr, (ob) => ...)` instead.
   */
  orderBy<OE extends OrderByExpression<DB, TB, {}>>(
    expr: OE,
    modifiers: Expression<any>,
  ): DeleteQueryBuilder<DB, TB, O>

  orderBy(...args: any[]): any {
    return new DeleteQueryBuilder({
      ...this.#props,
      queryNode: QueryNode.cloneWithOrderByItems(
        this.#props.queryNode,
        parseOrderBy(args),
      ),
    })
  }

  clearOrderBy(): DeleteQueryBuilder<DB, TB, O> {
    return new DeleteQueryBuilder<DB, TB, O>({
      ...this.#props,
      queryNode: QueryNode.cloneWithoutOrderBy(this.#props.queryNode),
    })
  }

  /**
   * Adds a limit clause to the query.
   *
   * A limit clause in a delete query is only supported by some dialects
   * like MySQL.
   *
   * ### Examples
   *
   * Delete 5 oldest items in a table:
   *
   * ```ts
   * await db
   *   .deleteFrom('pet')
   *   .orderBy('created_at')
   *   .limit(5)
   *   .execute()
   * ```
   *
   * The generated SQL (MySQL):
   *
   * ```sql
   * delete from `pet` order by `created_at` limit ?
   * ```
   */
  limit(limit: ValueExpression<DB, TB, number>): DeleteQueryBuilder<DB, TB, O> {
    return new DeleteQueryBuilder({
      ...this.#props,
      queryNode: DeleteQueryNode.cloneWithLimit(
        this.#props.queryNode,
        LimitNode.create(parseValueExpression(limit)),
      ),
    })
  }

  /**
   * This can be used to add any additional SQL to the end of the query.
   *
   * ### Examples
   *
   * ```ts
   * import { sql } from 'kysely'
   *
   * await db.deleteFrom('person')
   *   .where('first_name', '=', 'John')
   *   .modifyEnd(sql`-- This is a comment`)
   *   .execute()
   * ```
   *
   * The generated SQL (MySQL):
   *
   * ```sql
   * delete from `person`
   * where `first_name` = "John" -- This is a comment
   * ```
   */
  modifyEnd(modifier: Expression<any>): DeleteQueryBuilder<DB, TB, O> {
    return new DeleteQueryBuilder({
      ...this.#props,
      queryNode: QueryNode.cloneWithEndModifier(
        this.#props.queryNode,
        modifier.toOperationNode(),
      ),
    })
  }

  /**
   * Simply calls the provided function passing `this` as the only argument. `$call` returns
   * what the provided function returns.
   *
   * If you want to conditionally call a method on `this`, see
   * the {@link $if} method.
   *
   * ### Examples
   *
   * The next example uses a helper function `log` to log a query:
   *
   * ```ts
   * import type { Compilable } from 'kysely'
   *
   * function log<T extends Compilable>(qb: T): T {
   *   console.log(qb.compile())
   *   return qb
   * }
   *
   * await db.deleteFrom('person')
   *   .$call(log)
   *   .execute()
   * ```
   */
  $call<T>(func: (qb: this) => T): T {
    return func(this)
  }

  /**
   * Call `func(this)` if `condition` is true.
   *
   * This method is especially handy with optional selects. Any `returning` or `returningAll`
   * method calls add columns as optional fields to the output type when called inside
   * the `func` callback. This is because we can't know if those selections were actually
   * made before running the code.
   *
   * You can also call any other methods inside the callback.
   *
   * ### Examples
   *
   * ```ts
   * async function deletePerson(id: number, returnLastName: boolean) {
   *   return await db
   *     .deleteFrom('person')
   *     .where('id', '=', id)
   *     .returning(['id', 'first_name'])
   *     .$if(returnLastName, (qb) => qb.returning('last_name'))
   *     .executeTakeFirstOrThrow()
   * }
   * ```
   *
   * Any selections added inside the `if` callback will be added as optional fields to the
   * output type since we can't know if the selections were actually made before running
   * the code. In the example above the return type of the `deletePerson` function is:
   *
   * ```ts
   * Promise<{
   *   id: number
   *   first_name: string
   *   last_name?: string
   * }>
   * ```
   */
  $if<O2>(
    condition: boolean,
    func: (qb: this) => DeleteQueryBuilder<any, any, O2>,
  ): O2 extends DeleteResult
    ? DeleteQueryBuilder<DB, TB, DeleteResult>
    : O2 extends O & infer E
      ? DeleteQueryBuilder<DB, TB, O & Partial<E>>
      : DeleteQueryBuilder<DB, TB, Partial<O2>> {
    if (condition) {
      return func(this) as any
    }

    return new DeleteQueryBuilder({
      ...this.#props,
    }) as any
  }

  /**
   * Change the output type of the query.
   *
   * This method call doesn't change the SQL in any way. This methods simply
   * returns a copy of this `DeleteQueryBuilder` with a new output type.
   */
  $castTo<C>(): DeleteQueryBuilder<DB, TB, C> {
    return new DeleteQueryBuilder(this.#props)
  }

  /**
   * Narrows (parts of) the output type of the query.
   *
   * Kysely tries to be as type-safe as possible, but in some cases we have to make
   * compromises for better maintainability and compilation performance. At present,
   * Kysely doesn't narrow the output type of the query when using {@link where} and {@link returning} or {@link returningAll}.
   *
   * This utility method is very useful for these situations, as it removes unncessary
   * runtime assertion/guard code. Its input type is limited to the output type
   * of the query, so you can't add a column that doesn't exist, or change a column's
   * type to something that doesn't exist in its union type.
   *
   * ### Examples
   *
   * Turn this code:
   *
   * ```ts
   * import type { Person } from 'type-editor' // imaginary module
   *
   * const person = await db.deleteFrom('person')
   *   .where('id', '=', 3)
   *   .where('nullable_column', 'is not', null)
   *   .returningAll()
   *   .executeTakeFirstOrThrow()
   *
   * if (isWithNoNullValue(person)) {
   *   functionThatExpectsPersonWithNonNullValue(person)
   * }
   *
   * function isWithNoNullValue(person: Person): person is Person & { nullable_column: string } {
   *   return person.nullable_column != null
   * }
   * ```
   *
   * Into this:
   *
   * ```ts
   * import type { NotNull } from 'kysely'
   *
   * const person = await db.deleteFrom('person')
   *   .where('id', '=', 3)
   *   .where('nullable_column', 'is not', null)
   *   .returningAll()
   *   .$narrowType<{ nullable_column: NotNull }>()
   *   .executeTakeFirstOrThrow()
   *
   * functionThatExpectsPersonWithNonNullValue(person)
   * ```
   */
  $narrowType<T>(): DeleteQueryBuilder<DB, TB, NarrowPartial<O, T>> {
    return new DeleteQueryBuilder(this.#props)
  }

  /**
   * Asserts that query's output row type equals the given type `T`.
   *
   * This method can be used to simplify excessively complex types to make TypeScript happy
   * and much faster.
   *
   * Kysely uses complex type magic to achieve its type safety. This complexity is sometimes too much
   * for TypeScript and you get errors like this:
   *
   * ```
   * error TS2589: Type instantiation is excessively deep and possibly infinite.
   * ```
   *
   * In these case you can often use this method to help TypeScript a little bit. When you use this
   * method to assert the output type of a query, Kysely can drop the complex output type that
   * consists of multiple nested helper types and replace it with the simple asserted type.
   *
   * Using this method doesn't reduce type safety at all. You have to pass in a type that is
   * structurally equal to the current type.
   *
   * ### Examples
   *
   * ```ts
   * import type { Species } from 'type-editor' // imaginary module
   *
   * async function deletePersonAndPets(personId: number) {
   *   return await db
   *     .with('deleted_person', (qb) => qb
   *        .deleteFrom('person')
   *        .where('id', '=', personId)
   *        .returning('first_name')
   *        .$assertType<{ first_name: string }>()
   *     )
   *     .with('deleted_pets', (qb) => qb
   *       .deleteFrom('pet')
   *       .where('owner_id', '=', personId)
   *       .returning(['name as pet_name', 'species'])
   *       .$assertType<{ pet_name: string, species: Species }>()
   *     )
   *     .selectFrom(['deleted_person', 'deleted_pets'])
   *     .selectAll()
   *     .execute()
   * }
   * ```
   */
  $assertType<T extends O>(): O extends T
    ? DeleteQueryBuilder<DB, TB, T>
    : KyselyTypeError<`$assertType() call failed: The type passed in is not equal to the output type of the query.`> {
    return new DeleteQueryBuilder(this.#props) as unknown as any
  }

  /**
   * Returns a copy of this DeleteQueryBuilder instance with the given plugin installed.
   */
  withPlugin(plugin: KyselyPlugin): DeleteQueryBuilder<DB, TB, O> {
    return new DeleteQueryBuilder({
      ...this.#props,
      executor: this.#props.executor.withPlugin(plugin),
    })
  }

  toOperationNode(): DeleteQueryNode {
    return this.#props.executor.transformQuery(
      this.#props.queryNode,
      this.#props.queryId,
    )
  }

  compile(): CompiledQuery<SimplifyResult<O>> {
    return this.#props.executor.compileQuery(
      this.toOperationNode(),
      this.#props.queryId,
    )
  }

  /**
   * Executes the query and returns an array of rows.
   *
   * Also see the {@link executeTakeFirst} and {@link executeTakeFirstOrThrow} methods.
   */
  async execute(): Promise<SimplifyResult<O>[]> {
    const compiledQuery = this.compile()

    const result = await this.#props.executor.executeQuery<O>(compiledQuery)

    const { adapter } = this.#props.executor
    const query = compiledQuery.query as DeleteQueryNode

    if (
      (query.returning && adapter.supportsReturning) ||
      (query.output && adapter.supportsOutput)
    ) {
      return result.rows as any
    }

    return [new DeleteResult(result.numAffectedRows ?? BigInt(0)) as any]
  }

  /**
   * Executes the query and returns the first result or undefined if
   * the query returned no result.
   */
  async executeTakeFirst(): Promise<SimplifySingleResult<O>> {
    const [result] = await this.execute()
    return result as SimplifySingleResult<O>
  }

  /**
   * Executes the query and returns the first result or throws if
   * the query returned no result.
   *
   * By default an instance of {@link NoResultError} is thrown, but you can
   * provide a custom error class, or callback as the only argument to throw a different
   * error.
   */
  async executeTakeFirstOrThrow(
    errorConstructor:
      | NoResultErrorConstructor
      | ((node: QueryNode) => Error) = NoResultError,
  ): Promise<SimplifyResult<O>> {
    const result = await this.executeTakeFirst()

    if (result === undefined) {
      const error = isNoResultErrorConstructor(errorConstructor)
        ? new errorConstructor(this.toOperationNode())
        : errorConstructor(this.toOperationNode())

      throw error
    }

    return result as SimplifyResult<O>
  }

  async *stream(chunkSize: number = 100): AsyncIterableIterator<O> {
    const compiledQuery = this.compile()

    const stream = this.#props.executor.stream<O>(compiledQuery, chunkSize)

    for await (const item of stream) {
      yield* item.rows
    }
  }

  async explain<ER extends Record<string, any> = Record<string, any>>(
    format?: ExplainFormat,
    options?: Expression<any>,
  ): Promise<ER[]> {
    const builder = new DeleteQueryBuilder<DB, TB, ER>({
      ...this.#props,
      queryNode: QueryNode.cloneWithExplain(
        this.#props.queryNode,
        format,
        options,
      ),
    })

    return await builder.execute()
  }
}

export interface DeleteQueryBuilderProps {
  readonly queryId: QueryId
  readonly queryNode: DeleteQueryNode
  readonly executor: QueryExecutor
}

export type DeleteQueryBuilderWithInnerJoin<
  DB,
  TB extends keyof DB,
  O,
  TE extends TableExpression<DB, TB>,
> = TE extends `${infer T} as ${infer A}`
  ? T extends keyof DB
    ? InnerJoinedBuilder<DB, TB, O, A, DB[T]>
    : never
  : TE extends keyof DB
    ? DeleteQueryBuilder<DB, TB | TE, O>
    : TE extends AliasedExpression<infer QO, infer QA>
      ? InnerJoinedBuilder<DB, TB, O, QA, QO>
      : TE extends (qb: any) => AliasedExpression<infer QO, infer QA>
        ? InnerJoinedBuilder<DB, TB, O, QA, QO>
        : never

type InnerJoinedBuilder<
  DB,
  TB extends keyof DB,
  O,
  A extends string,
  R,
> = A extends keyof DB
  ? DeleteQueryBuilder<InnerJoinedDB<DB, A, R>, TB | A, O>
  : // Much faster non-recursive solution for the simple case.
    DeleteQueryBuilder<DB & ShallowRecord<A, R>, TB | A, O>

type InnerJoinedDB<DB, A extends string, R> = DrainOuterGeneric<{
  [C in keyof DB | A]: C extends A ? R : C extends keyof DB ? DB[C] : never
}>

export type DeleteQueryBuilderWithLeftJoin<
  DB,
  TB extends keyof DB,
  O,
  TE extends TableExpression<DB, TB>,
> = TE extends `${infer T} as ${infer A}`
  ? T extends keyof DB
    ? LeftJoinedBuilder<DB, TB, O, A, DB[T]>
    : never
  : TE extends keyof DB
    ? LeftJoinedBuilder<DB, TB, O, TE, DB[TE]>
    : TE extends AliasedExpression<infer QO, infer QA>
      ? LeftJoinedBuilder<DB, TB, O, QA, QO>
      : TE extends (qb: any) => AliasedExpression<infer QO, infer QA>
        ? LeftJoinedBuilder<DB, TB, O, QA, QO>
        : never

type LeftJoinedBuilder<
  DB,
  TB extends keyof DB,
  O,
  A extends keyof any,
  R,
> = A extends keyof DB
  ? DeleteQueryBuilder<LeftJoinedDB<DB, A, R>, TB | A, O>
  : // Much faster non-recursive solution for the simple case.
    DeleteQueryBuilder<DB & ShallowRecord<A, Nullable<R>>, TB | A, O>

type LeftJoinedDB<DB, A extends keyof any, R> = DrainOuterGeneric<{
  [C in keyof DB | A]: C extends A
    ? Nullable<R>
    : C extends keyof DB
      ? DB[C]
      : never
}>

export type DeleteQueryBuilderWithRightJoin<
  DB,
  TB extends keyof DB,
  O,
  TE extends TableExpression<DB, TB>,
> = TE extends `${infer T} as ${infer A}`
  ? T extends keyof DB
    ? RightJoinedBuilder<DB, TB, O, A, DB[T]>
    : never
  : TE extends keyof DB
    ? RightJoinedBuilder<DB, TB, O, TE, DB[TE]>
    : TE extends AliasedExpression<infer QO, infer QA>
      ? RightJoinedBuilder<DB, TB, O, QA, QO>
      : TE extends (qb: any) => AliasedExpression<infer QO, infer QA>
        ? RightJoinedBuilder<DB, TB, O, QA, QO>
        : never

type RightJoinedBuilder<
  DB,
  TB extends keyof DB,
  O,
  A extends keyof any,
  R,
> = DeleteQueryBuilder<RightJoinedDB<DB, TB, A, R>, TB | A, O>

type RightJoinedDB<
  DB,
  TB extends keyof DB,
  A extends keyof any,
  R,
> = DrainOuterGeneric<{
  [C in keyof DB | A]: C extends A
    ? R
    : C extends TB
      ? Nullable<DB[C]>
      : C extends keyof DB
        ? DB[C]
        : never
}>

export type DeleteQueryBuilderWithFullJoin<
  DB,
  TB extends keyof DB,
  O,
  TE extends TableExpression<DB, TB>,
> = TE extends `${infer T} as ${infer A}`
  ? T extends keyof DB
    ? OuterJoinedBuilder<DB, TB, O, A, DB[T]>
    : never
  : TE extends keyof DB
    ? OuterJoinedBuilder<DB, TB, O, TE, DB[TE]>
    : TE extends AliasedExpression<infer QO, infer QA>
      ? OuterJoinedBuilder<DB, TB, O, QA, QO>
      : TE extends (qb: any) => AliasedExpression<infer QO, infer QA>
        ? OuterJoinedBuilder<DB, TB, O, QA, QO>
        : never

type OuterJoinedBuilder<
  DB,
  TB extends keyof DB,
  O,
  A extends keyof any,
  R,
> = DeleteQueryBuilder<OuterJoinedBuilderDB<DB, TB, A, R>, TB | A, O>

type OuterJoinedBuilderDB<
  DB,
  TB extends keyof DB,
  A extends keyof any,
  R,
> = DrainOuterGeneric<{
  [C in keyof DB | A]: C extends A
    ? Nullable<R>
    : C extends TB
      ? Nullable<DB[C]>
      : C extends keyof DB
        ? DB[C]
        : never
}>
