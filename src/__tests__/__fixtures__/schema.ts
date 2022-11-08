import {
  IntrospectionQuery,
  buildSchema,
  getIntrospectionQuery,
  graphql,
} from 'graphql';

const schema = buildSchema(/* GraphQL */ `
  type Query {
    simple: String!
    nested: Nested!
    list(input: String): [String!]!
    listNested(input: ListInput): [Nested!]!
  }

  type Nested {
    name: String!
    deeplyNested: Nested
  }

  input ListInput {
    topInput: String
    nested: ListNestedInput
  }

  input ListNestedInput {
    nestedInput: String
  }
`);

export default graphql({
  schema,
  source: getIntrospectionQuery({ descriptions: false }),
}).then(({ data }) => (data as unknown) as IntrospectionQuery);

// const root = {
//   simple: () => 'a',
//   nested: () => ({ name: 'a' }),
//   list: () => ['a', 'a'],
//   listNested: () => [{ name: 'a' }, { name: 'a' }],
// };

// graphql(schema, ' { list }', root).then(r =>
//   console.log(JSON.stringify(r, null, 2))
// );
