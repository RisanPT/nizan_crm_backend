import User from '../models/User.js';

export const seedAdminUser = async () => {
  const email = String(process.env.ADMIN_EMAIL ?? '')
    .trim()
    .toLowerCase();
  const password = String(process.env.ADMIN_PASSWORD ?? '').trim();

  if (!email || !password) {
    console.warn(
      'Admin seed skipped because ADMIN_EMAIL or ADMIN_PASSWORD is missing.'
    );
    return;
  }

  const existingUser = await User.findOne({ email });

  if (existingUser) {
    return;
  }

  await User.create({
    name: String(process.env.ADMIN_NAME ?? 'Admin User').trim(),
    email,
    password,
    role: String(process.env.ADMIN_ROLE ?? 'manager').trim() || 'manager',
    active: true,
  });

  console.log(`Seeded admin user: ${email}`);
};
