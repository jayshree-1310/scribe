import {
  defineContract,
  field,
  model,
} from '@prisma/orm-postgres/contract-builder';

export const contract = defineContract(
  {
    namespaces: ['auth'],
  },
  ({ field, model }) => {
    const User = model('User', {
      fields: {
        id: field.id.uuidv4String(),
        username: field.text().unique(),
        email: field.text().unique(),
      },
    }).sql({
      table: 'user',
      namespace: 'auth',
    });

    return {
      models: {
        User,
      },
    };
  },
);
