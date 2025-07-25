import {
  expectAssignable,
  expectError,
  expectNotAssignable,
  expectType,
} from 'tsd'
import {
  ColumnType,
  Expression,
  ExpressionBuilder,
  Generated,
  Kysely,
  SqlBool,
  expressionBuilder,
} from '..'
import { KyselyTypeError } from '../../../dist/cjs/util/type-error'
import { Database } from '../shared'

function testExpression(db: Kysely<Database>) {
  const e1: Expression<number> = undefined!

  expectAssignable<Expression<number>>(e1)
  expectNotAssignable<Expression<string>>(e1)

  expectAssignable<Expression<{ first_name: string }>>(
    db.selectFrom('person').select('first_name'),
  )
  expectNotAssignable<Expression<{ first_name: number }>>(
    db.selectFrom('person').select('first_name'),
  )
  expectNotAssignable<Expression<{ age: number }>>(
    db.selectFrom('person').select('first_name'),
  )
}

async function testExpressionBuilder(
  eb: ExpressionBuilder<Database, 'person'>,
) {
  // Binary expression
  expectAssignable<Expression<number>>(eb('age', '+', 1))

  // `not` expression
  expectAssignable<Expression<SqlBool>>(eb.not(eb('age', '>', 10)))

  // `and` expression with one item
  expectAssignable<Expression<SqlBool>>(
    eb.and([eb('first_name', '=', 'Jennifer')]),
  )

  // `and` expression with two items
  expectAssignable<Expression<SqlBool>>(
    eb.and([
      eb('first_name', '=', 'Jennifer'),
      eb.not(eb('last_name', '=', 'Aniston')),
    ]),
  )

  // `or` expression with one item
  expectAssignable<Expression<SqlBool>>(
    eb.or([eb('first_name', '=', 'Jennifer')]),
  )

  // `or` expression with two items
  expectAssignable<Expression<SqlBool>>(
    eb.or([
      eb('first_name', '=', 'Jennifer'),
      eb.not(eb('last_name', '=', 'Aniston')),
    ]),
  )

  // `or` chain with three items
  expectAssignable<Expression<SqlBool>>(
    eb('first_name', '=', 'Jennifer')
      .or(eb.not(eb('last_name', '=', 'Aniston')))
      .or('age', '>', 23),
  )

  // `and` chain with three items
  expectAssignable<Expression<SqlBool>>(
    eb('first_name', '=', 'Jennifer')
      .and(eb.not(eb('last_name', '=', 'Aniston')))
      .and('age', '>', 23),
  )

  // nested `and` and `or` chains.
  expectAssignable<Expression<SqlBool>>(
    eb.and([
      eb('age', '=', 1).or('age', '=', 2),
      eb('first_name', '=', 'Jennifer').or('first_name', '=', 'Arnold'),
    ]),
  )

  expectAssignable<Expression<1>>(eb.lit(1))
  expectAssignable<Expression<boolean>>(eb.lit(true))
  expectAssignable<Expression<null>>(eb.lit(null))

  expectAssignable<Expression<SqlBool>>(
    eb.and({
      'person.age': 10,
      first_name: 'Jennifer',
      last_name: eb.ref('first_name'),
    }),
  )

  expectAssignable<Expression<SqlBool>>(
    eb.or({
      'person.age': 10,
      first_name: 'Jennifer',
      last_name: eb.ref('first_name'),
    }),
  )

  expectAssignable<Expression<number | null>>(
    eb.case().when('age', '=', 10).then(1).else(null).end(),
  )

  expectNotAssignable<Expression<number>>(
    eb.case().when('age', '=', 10).then(1).else(null).end(),
  )

  expectAssignable<Expression<number>>(
    eb.case().when('age', '=', 10).then(1).else(null).end().$notNull(),
  )

  expectType<
    KyselyTypeError<'or() method can only be called on boolean expressions'>
  >(eb('age', '+', 1).or('age', '=', 1))

  expectType<
    KyselyTypeError<'and() method can only be called on boolean expressions'>
  >(eb('age', '+', 1).and('age', '=', 1))

  // `neg` expression
  expectAssignable<Expression<number>>(eb.neg(eb('age', '+', 10)))

  // Binary expression in a comparison expression
  expectAssignable<Expression<SqlBool>>(eb(eb('age', '+', 1), '>', 0))

  // A custom function call
  expectAssignable<Expression<string>>(eb.fn<string>('upper', ['first_name']))

  expectAssignable<Expression<SqlBool>>(eb.between('age', 10, 20))
  expectAssignable<Expression<SqlBool>>(eb.betweenSymmetric('age', 10, 20))

  expectAssignable<Expression<string>>(eb.cast<string>('age', 'text'))
  expectAssignable<Expression<string>>(eb.cast<string>(eb.ref('age'), 'text'))

  expectError(eb('not_a_person_column', '=', 'Jennifer'))
  expectError(eb('not_a_person_column', '=', 'Jennifer'))

  expectError(eb.and([eb.val('not booleanish'), eb.val(true)]))
  expectError(eb.and([eb('age', '+', 1), eb.val(true)]))

  expectError(eb.or([eb.val('not booleanish'), eb.val(true)]))
  expectError(eb.or([eb('age', '+', 1), eb.val(true)]))

  expectError(eb.and({ unknown_column: 'Jennifer' }))
  expectError(eb.and({ age: 'wrong type' }))

  expectError(eb.or({ unknown_column: 'Jennifer' }))
  expectError(eb.or({ age: 'wrong type' }))

  // String literals are not allowed.
  expectError(eb.lit('foobar'))

  expectError(eb.between('age', 'wrong type', 2))
  expectError(eb.between('age', 1, 'wrong type'))
  expectError(eb.betweenSymmetric('age', 'wrong type', 2))
  expectError(eb.betweenSymmetric('age', 1, 'wrong type'))
}

async function textExpressionBuilderAny(
  eb: ExpressionBuilder<
    Database & {
      actor: {
        id: string
        movie_earnings: number[]
        nicknames: string[] | null
      }
    },
    'actor'
  >,
) {
  expectAssignable<Expression<string>>(eb.fn.any('nicknames'))
  expectAssignable<Expression<number>>(eb.fn.any('movie_earnings'))
  expectAssignable<Expression<number>>(eb.fn.any(eb.val([1, 2, 3])))

  expectAssignable<Expression<SqlBool>>(
    eb(eb.val('Jen'), '=', eb.fn.any('nicknames')),
  )

  expectAssignable<Expression<SqlBool>>(
    eb(eb.val(42_000_000), '=', eb.fn.any('movie_earnings')),
  )

  expectAssignable<Expression<SqlBool>>(
    eb(eb.val('cat'), '=', eb.fn.any(eb.selectFrom('pet').select('species'))),
  )

  // Wrong array type
  expectError(eb(eb.val('Jen'), '=', eb.fn.any('movie_earnings')))

  // Not an array
  expectError(eb(eb.val('Jen'), '=', eb.fn.any('id')))
}

async function testExpressionBuilderAnyWithColumnType(
  eb: ExpressionBuilder<
    Database & {
      person_with_column_type: {
        id: Generated<number>
        ids: ColumnType<number[] | null>
        names: ColumnType<string[], never, string[]>
        regular_array: number[]
      }
    },
    'person_with_column_type'
  >,
) {
  expectAssignable<Expression<number>>(eb.fn.any('ids'))
  expectAssignable<Expression<string>>(eb.fn.any('names'))
  expectAssignable<Expression<number>>(eb.fn.any('regular_array'))

  // Should work in where clauses
  expectAssignable<Expression<SqlBool>>(eb(eb.val(42), '=', eb.fn.any('ids')))
  expectAssignable<Expression<SqlBool>>(
    eb(eb.val('test'), '=', eb.fn.any('names')),
  )
}

function testExpressionBuilderTuple(db: Kysely<Database>) {
  db.selectFrom('person')
    .selectAll()
    .where(({ eb, refTuple, tuple }) =>
      eb(refTuple('first_name', 'last_name'), 'in', [
        tuple('Jennifer', 'Aniston'),
        tuple('Sylvester', 'Stallone'),
      ]),
    )

  db.selectFrom('person')
    .selectAll()
    .where(({ eb, refTuple, selectFrom }) =>
      eb(
        refTuple('first_name', 'last_name'),
        'in',
        selectFrom('person')
          .select(['first_name', 'last_name'])
          .$asTuple('first_name', 'last_name'),
      ),
    )

  // Wrong tuple type
  expectError(
    db
      .selectFrom('person')
      .where(({ eb, refTuple, tuple }) =>
        eb(refTuple('first_name', 'last_name'), 'in', [
          tuple('Jennifer', 'Aniston'),
          tuple('Sylvester', 1),
        ]),
      ),
  )

  // Wrong tuple length
  expectError(
    db
      .selectFrom('person')
      .where(({ eb, refTuple, tuple }) =>
        eb(refTuple('first_name', 'last_name'), 'in', [
          tuple('Jennifer', 'Aniston', 'Extra'),
          tuple('Sylvester', 'Stallone'),
        ]),
      ),
  )

  // Not all selected columns provided for $asTuple
  expectType<
    KyselyTypeError<'$asTuple() call failed: All selected columns must be provided as arguments'>
  >(
    db
      .selectFrom('person')
      .select(['first_name', 'last_name', 'age'])
      .$asTuple('first_name', 'last_name'),
  )

  // Duplicate column provided for $asTuple
  expectError(
    db
      .selectFrom('person')
      .select(['first_name', 'last_name'])
      .$asTuple('first_name', 'last_name', 'last_name'),
  )
}

function testExpressionBuilderConstructor(db: Kysely<Database>) {
  const eb1 = expressionBuilder<Database, 'person'>()
  expectType<ExpressionBuilder<Database, 'person'>>(eb1)

  const eb2 = expressionBuilder<Database>()
  expectType<ExpressionBuilder<Database, never>>(eb2)

  const eb3 = expressionBuilder(
    db.selectFrom('action').innerJoin('pet', (join) => join.onTrue()),
  )
  expectType<ExpressionBuilder<Database, 'action' | 'pet'>>(eb3)
}
