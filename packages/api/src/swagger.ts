import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import type { Express, Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import type { JwtPayload } from '@gaslink/shared';
import { config } from './config/index.js';
import { prisma } from './lib/prisma.js';

// ─── OpenAPI Specification ──────────────────────────────────────────────────

const swaggerDefinition: swaggerJsdoc.OAS3Definition = {
  openapi: '3.0.3',
  info: {
    title: 'GasLink API',
    version: '1.0.0',
    description:
      'GasLink LPG Distribution SaaS API. Manages distributors, customers, orders, inventory, invoicing, payments, drivers, vehicles, analytics, and billing.',
    contact: {
      name: 'GasLink Support',
      email: 'info@mygaslink.com',
    },
  },
  servers: [
    {
      url: '/api',
      description: 'API base path',
    },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'JWT access token obtained from POST /auth/login',
      },
    },
    parameters: {
      distributorHeader: {
        name: 'X-Distributor-Id',
        in: 'header',
        required: false,
        description: 'Distributor context (required for super_admin operating on a specific distributor)',
        schema: { type: 'string', format: 'uuid' },
      },
      idPath: {
        name: 'id',
        in: 'path',
        required: true,
        schema: { type: 'string', format: 'uuid' },
      },
      page: {
        name: 'page',
        in: 'query',
        schema: { type: 'integer', minimum: 1, default: 1 },
      },
      pageSize: {
        name: 'pageSize',
        in: 'query',
        schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
    },
    schemas: {
      ApiResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          data: { type: 'object', nullable: true },
          error: { type: 'string', nullable: true },
          code: { type: 'string', nullable: true },
          meta: {
            type: 'object',
            nullable: true,
            properties: {
              total: { type: 'integer' },
              page: { type: 'integer' },
              pageSize: { type: 'integer' },
              totalPages: { type: 'integer' },
            },
          },
        },
      },
      Error: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: false },
          data: { type: 'object', nullable: true, example: null },
          error: { type: 'string' },
          code: { type: 'string' },
        },
      },
    },
  },
  security: [{ bearerAuth: [] }],
  tags: [
    { name: 'Auth', description: 'Authentication & session management' },
    { name: 'Users', description: 'User management (admin)' },
    { name: 'Distributors', description: 'Distributor management (super_admin)' },
    { name: 'Customers', description: 'Customer CRUD, supply control, portal access' },
    { name: 'Cylinder Types', description: 'Cylinder types, prices, thresholds' },
    { name: 'Orders', description: 'Order lifecycle, driver assignment, delivery confirmation, returns' },
    { name: 'Invoices', description: 'Invoice CRUD, credit/debit notes, GST compliance' },
    { name: 'Payments', description: 'Payment recording and customer ledger' },
    { name: 'Inventory', description: 'Stock summary, incoming/outgoing, adjustments, cancelled stock' },
    { name: 'Drivers', description: 'Driver CRUD, availability, performance, vehicle assignments' },
    { name: 'Vehicles', description: 'Vehicle CRUD, inventory tracking, cancelled stock' },
    { name: 'Analytics', description: 'Dashboard, metrics, reports, trends, exports' },
    { name: 'Settings', description: 'Distributor settings, GST credentials, approval workflows, licenses' },
    { name: 'Billing', description: 'Platform billing cycles (super_admin)' },
    { name: 'Pending Actions', description: 'Approval queue: list, approve, resolve, reject' },
    { name: 'Accountability', description: 'Cylinder accountability logs' },
    { name: 'Delivery Workflow', description: 'Customer confirmation, vehicle return, reconciliation' },
    { name: 'Assignments', description: 'Driver-vehicle mappings, order recommendations, bulk assignment' },
    { name: 'Customer Portal', description: 'Customer self-service portal' },
    { name: 'Health', description: 'Health check' },
    { name: 'Contact', description: 'Contact form (public)' },
  ],
  paths: {
    // ─── Health ──────────────────────────────────────────────────────────
    '/health': {
      get: {
        tags: ['Health'],
        summary: 'Health check',
        security: [],
        responses: { '200': { description: 'OK' } },
      },
    },

    // ─── Auth ────────────────────────────────────────────────────────────
    '/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Login with email and password',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'password'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  password: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Login successful - returns tokens and user info' },
          '401': { description: 'Invalid credentials' },
          '429': { description: 'Rate limited' },
        },
      },
    },
    '/auth/refresh': {
      post: {
        tags: ['Auth'],
        summary: 'Refresh token pair',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['refreshToken'],
                properties: { refreshToken: { type: 'string' } },
              },
            },
          },
        },
        responses: {
          '200': { description: 'New token pair' },
          '401': { description: 'Invalid or expired refresh token' },
        },
      },
    },
    '/auth/change-password': {
      post: {
        tags: ['Auth'],
        summary: 'Change current user password',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['currentPassword', 'newPassword'],
                properties: {
                  currentPassword: { type: 'string' },
                  newPassword: { type: 'string', minLength: 8 },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'Password changed' } },
      },
    },
    '/auth/logout': {
      post: {
        tags: ['Auth'],
        summary: 'Logout (revoke refresh token)',
        responses: { '200': { description: 'Logged out' } },
      },
    },
    '/auth/me': {
      get: {
        tags: ['Auth'],
        summary: 'Get current user profile',
        responses: { '200': { description: 'Current user info' } },
      },
    },

    // ─── Users ───────────────────────────────────────────────────────────
    '/users': {
      get: {
        tags: ['Users'],
        summary: 'List users',
        parameters: [{ $ref: '#/components/parameters/distributorHeader' }],
        responses: { '200': { description: 'User list' } },
      },
      post: {
        tags: ['Users'],
        summary: 'Create user',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object' } } },
        },
        responses: { '201': { description: 'User created' } },
      },
    },
    '/users/profile': {
      get: {
        tags: ['Users'],
        summary: 'Get current user profile (detailed)',
        responses: { '200': { description: 'User profile' } },
      },
    },
    '/users/{id}': {
      get: {
        tags: ['Users'],
        summary: 'Get user by ID',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        responses: { '200': { description: 'User details' } },
      },
      put: {
        tags: ['Users'],
        summary: 'Update user',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object' } } },
        },
        responses: { '200': { description: 'User updated' } },
      },
      delete: {
        tags: ['Users'],
        summary: 'Soft-delete user',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        responses: { '200': { description: 'User deleted' } },
      },
    },

    // ─── Distributors ────────────────────────────────────────────────────
    '/distributors': {
      get: {
        tags: ['Distributors'],
        summary: 'List all distributors (super_admin only)',
        responses: { '200': { description: 'Distributor list' } },
      },
      post: {
        tags: ['Distributors'],
        summary: 'Create distributor (super_admin only)',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object' } } },
        },
        responses: { '201': { description: 'Distributor created' } },
      },
    },
    '/distributors/{id}': {
      get: {
        tags: ['Distributors'],
        summary: 'Get distributor by ID',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        responses: { '200': { description: 'Distributor details' } },
      },
      put: {
        tags: ['Distributors'],
        summary: 'Update distributor',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object' } } },
        },
        responses: { '200': { description: 'Distributor updated' } },
      },
    },
    '/distributors/{id}/settings': {
      get: {
        tags: ['Distributors'],
        summary: 'Get distributor settings',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        responses: { '200': { description: 'Distributor settings' } },
      },
    },

    // ─── Customers ───────────────────────────────────────────────────────
    '/customers': {
      get: {
        tags: ['Customers'],
        summary: 'List customers (paginated, filterable)',
        parameters: [
          { $ref: '#/components/parameters/distributorHeader' },
          { $ref: '#/components/parameters/page' },
          { $ref: '#/components/parameters/pageSize' },
          { name: 'search', in: 'query', schema: { type: 'string' } },
          { name: 'status', in: 'query', schema: { type: 'string' } },
          { name: 'supplyStatus', in: 'query', schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'Paginated customer list' } },
      },
      post: {
        tags: ['Customers'],
        summary: 'Create customer',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object' } } },
        },
        responses: { '201': { description: 'Customer created' } },
      },
    },
    '/customers/{id}': {
      get: {
        tags: ['Customers'],
        summary: 'Get customer by ID',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        responses: { '200': { description: 'Customer details' } },
      },
      put: {
        tags: ['Customers'],
        summary: 'Update customer',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object' } } },
        },
        responses: { '200': { description: 'Customer updated' } },
      },
      delete: {
        tags: ['Customers'],
        summary: 'Soft-delete customer',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        responses: { '200': { description: 'Customer deleted' } },
      },
    },
    '/customers/{id}/stop-supply': {
      post: {
        tags: ['Customers'],
        summary: 'Stop supply for customer',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        responses: { '200': { description: 'Supply stopped' } },
      },
    },
    '/customers/{id}/resume-supply': {
      post: {
        tags: ['Customers'],
        summary: 'Resume supply for customer',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        responses: { '200': { description: 'Supply resumed' } },
      },
    },
    '/customers/{id}/portal-access': {
      post: {
        tags: ['Customers'],
        summary: 'Provision customer portal login',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'password', 'firstName', 'lastName'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  password: { type: 'string', minLength: 8 },
                  firstName: { type: 'string' },
                  lastName: { type: 'string' },
                },
              },
            },
          },
        },
        responses: { '201': { description: 'Portal access created' } },
      },
    },
    '/customers/{id}/balance-setup': {
      post: {
        tags: ['Customers'],
        summary: 'Set up initial cylinder balances for customer',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object' } } },
        },
        responses: { '200': { description: 'Balances set up' } },
      },
    },
    '/customers/{id}/modification-requests': {
      post: {
        tags: ['Customers'],
        summary: 'Create customer modification request',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['modificationType'],
                properties: {
                  modificationType: { type: 'string', enum: ['update_info', 'credit_limit_change', 'stop_supply', 'resume_supply'] },
                  reason: { type: 'string' },
                  changes: { type: 'object' },
                },
              },
            },
          },
        },
        responses: { '201': { description: 'Modification request created' } },
      },
    },
    '/customers/modification-requests/{requestId}/approve': {
      put: {
        tags: ['Customers'],
        summary: 'Approve customer modification request',
        parameters: [{ name: 'requestId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'Request approved' } },
      },
    },
    '/customers/modification-requests/{requestId}/reject': {
      put: {
        tags: ['Customers'],
        summary: 'Reject customer modification request',
        parameters: [{ name: 'requestId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          content: { 'application/json': { schema: { type: 'object', properties: { reason: { type: 'string' } } } } },
        },
        responses: { '200': { description: 'Request rejected' } },
      },
    },
    '/customers/{id}/audit-trail': {
      get: {
        tags: ['Customers'],
        summary: 'Get customer audit trail',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        responses: { '200': { description: 'Audit trail entries' } },
      },
    },

    // ─── Cylinder Types ──────────────────────────────────────────────────
    '/cylinder-types': {
      get: {
        tags: ['Cylinder Types'],
        summary: 'List cylinder types',
        responses: { '200': { description: 'Cylinder types list' } },
      },
      post: {
        tags: ['Cylinder Types'],
        summary: 'Create cylinder type',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['typeName', 'capacity'],
                properties: {
                  typeName: { type: 'string' },
                  capacity: { type: 'number' },
                  unit: { type: 'string' },
                  hsnCode: { type: 'string' },
                },
              },
            },
          },
        },
        responses: { '201': { description: 'Cylinder type created' } },
      },
    },
    '/cylinder-types/{id}': {
      get: {
        tags: ['Cylinder Types'],
        summary: 'Get cylinder type by ID',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        responses: { '200': { description: 'Cylinder type details' } },
      },
      put: {
        tags: ['Cylinder Types'],
        summary: 'Update cylinder type',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { '200': { description: 'Cylinder type updated' } },
      },
      delete: {
        tags: ['Cylinder Types'],
        summary: 'Deactivate cylinder type',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        responses: { '200': { description: 'Cylinder type deactivated' } },
      },
    },
    '/cylinder-types/prices/list': {
      get: {
        tags: ['Cylinder Types'],
        summary: 'List cylinder prices',
        parameters: [{ name: 'cylinderTypeId', in: 'query', schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'Price list' } },
      },
    },
    '/cylinder-types/prices': {
      post: {
        tags: ['Cylinder Types'],
        summary: 'Create cylinder price',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['cylinderTypeId', 'price', 'effectiveDate'],
                properties: {
                  cylinderTypeId: { type: 'string', format: 'uuid' },
                  price: { type: 'number' },
                  effectiveDate: { type: 'string', format: 'date' },
                },
              },
            },
          },
        },
        responses: { '201': { description: 'Price created' } },
      },
    },
    '/cylinder-types/prices/{id}': {
      delete: {
        tags: ['Cylinder Types'],
        summary: 'Delete cylinder price',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        responses: { '200': { description: 'Price deleted' } },
      },
    },
    '/cylinder-types/empty-prices/list': {
      get: {
        tags: ['Cylinder Types'],
        summary: 'List empty cylinder prices',
        responses: { '200': { description: 'Empty prices list' } },
      },
    },
    '/cylinder-types/empty-prices': {
      put: {
        tags: ['Cylinder Types'],
        summary: 'Upsert empty cylinder price',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['cylinderTypeId', 'emptyCylinderPrice'],
                properties: {
                  cylinderTypeId: { type: 'string', format: 'uuid' },
                  emptyCylinderPrice: { type: 'number' },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'Empty price set' } },
      },
    },
    '/cylinder-types/thresholds': {
      put: {
        tags: ['Cylinder Types'],
        summary: 'Upsert cylinder threshold',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { '200': { description: 'Threshold set' } },
      },
    },

    // ─── Orders ──────────────────────────────────────────────────────────
    '/orders': {
      get: {
        tags: ['Orders'],
        summary: 'List orders (paginated, filterable)',
        parameters: [
          { $ref: '#/components/parameters/page' },
          { $ref: '#/components/parameters/pageSize' },
          { name: 'status', in: 'query', schema: { type: 'string' } },
          { name: 'customerId', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'driverId', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'dateFrom', in: 'query', schema: { type: 'string', format: 'date' } },
          { name: 'dateTo', in: 'query', schema: { type: 'string', format: 'date' } },
        ],
        responses: { '200': { description: 'Paginated order list' } },
      },
      post: {
        tags: ['Orders'],
        summary: 'Create order',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { '201': { description: 'Order created' } },
      },
    },
    '/orders/{id}': {
      get: {
        tags: ['Orders'],
        summary: 'Get order by ID',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        responses: { '200': { description: 'Order details' } },
      },
      put: {
        tags: ['Orders'],
        summary: 'Update order',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { '200': { description: 'Order updated' } },
      },
    },
    '/orders/{id}/status': {
      put: {
        tags: ['Orders'],
        summary: 'Update order status',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['status'],
                properties: {
                  status: { type: 'string' },
                  notes: { type: 'string' },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'Status updated' } },
      },
    },
    '/orders/{id}/assign-driver': {
      post: {
        tags: ['Orders'],
        summary: 'Assign driver to order',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { '200': { description: 'Driver assigned' } },
      },
    },
    '/orders/bulk-assign-driver': {
      post: {
        tags: ['Orders'],
        summary: 'Bulk-assign driver to multiple orders',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { '200': { description: 'Drivers assigned' } },
      },
    },
    '/orders/{id}/confirm-delivery': {
      post: {
        tags: ['Orders'],
        summary: 'Confirm delivery of order',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { '200': { description: 'Delivery confirmed' } },
      },
    },
    '/orders/{id}/confirm-returns': {
      post: {
        tags: ['Orders'],
        summary: 'Confirm empty cylinder returns collection',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { '200': { description: 'Returns confirmed' } },
      },
    },
    '/orders/{id}/cancel': {
      post: {
        tags: ['Orders'],
        summary: 'Cancel order',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['reason'],
                properties: { reason: { type: 'string' } },
              },
            },
          },
        },
        responses: { '200': { description: 'Order cancelled' } },
      },
    },
    '/orders/returns-only': {
      post: {
        tags: ['Orders'],
        summary: 'Create returns-only order (no delivery)',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { '201': { description: 'Returns-only order created' } },
      },
    },
    '/orders/from-cancelled-stock': {
      post: {
        tags: ['Orders'],
        summary: 'Create order from cancelled stock on vehicle',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['customerId', 'deliveryDate', 'cancelledStockEventId'],
                properties: {
                  customerId: { type: 'string', format: 'uuid' },
                  deliveryDate: { type: 'string', format: 'date' },
                  cancelledStockEventId: { type: 'string', format: 'uuid' },
                  specialInstructions: { type: 'string' },
                },
              },
            },
          },
        },
        responses: { '201': { description: 'Order created from cancelled stock' } },
      },
    },

    // ─── Invoices ────────────────────────────────────────────────────────
    '/invoices': {
      get: {
        tags: ['Invoices'],
        summary: 'List invoices (paginated, filterable)',
        parameters: [
          { $ref: '#/components/parameters/page' },
          { $ref: '#/components/parameters/pageSize' },
          { name: 'status', in: 'query', schema: { type: 'string' } },
          { name: 'customerId', in: 'query', schema: { type: 'string', format: 'uuid' } },
        ],
        responses: { '200': { description: 'Paginated invoice list' } },
      },
    },
    '/invoices/{id}': {
      get: {
        tags: ['Invoices'],
        summary: 'Get invoice by ID',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        responses: { '200': { description: 'Invoice details' } },
      },
    },
    '/invoices/from-order/{orderId}': {
      post: {
        tags: ['Invoices'],
        summary: 'Create invoice from delivered order',
        parameters: [{ name: 'orderId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '201': { description: 'Invoice created' } },
      },
    },
    '/invoices/manual': {
      post: {
        tags: ['Invoices'],
        summary: 'Create manual invoice',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { '201': { description: 'Manual invoice created' } },
      },
    },
    '/invoices/{id}/status': {
      put: {
        tags: ['Invoices'],
        summary: 'Update invoice status',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['status'], properties: { status: { type: 'string' } } },
            },
          },
        },
        responses: { '200': { description: 'Status updated' } },
      },
    },
    '/invoices/mark-overdue': {
      post: {
        tags: ['Invoices'],
        summary: 'Mark overdue invoices',
        responses: { '200': { description: 'Overdue invoices marked' } },
      },
    },
    '/invoices/{id}/pdf': {
      get: {
        tags: ['Invoices'],
        summary: 'Download invoice PDF (not yet implemented)',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        responses: { '501': { description: 'Not implemented' } },
      },
    },
    '/invoices/validate-gstin': {
      post: {
        tags: ['Invoices'],
        summary: 'Validate a GSTIN via WhiteBooks GSP',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['gstin'], properties: { gstin: { type: 'string', minLength: 15, maxLength: 15 } } },
            },
          },
        },
        responses: { '200': { description: 'GSTIN validation result' } },
      },
    },
    '/invoices/retroactive-gst': {
      post: {
        tags: ['Invoices'],
        summary: 'Generate GST invoices for pre-toggle orders',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { fromDate: { type: 'string' }, toDate: { type: 'string' } },
              },
            },
          },
        },
        responses: { '200': { description: 'Retroactive GST invoices result' } },
      },
    },
    '/invoices/{id}/generate-gst': {
      post: {
        tags: ['Invoices'],
        summary: 'Generate IRN and e-Way Bill for invoice',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        responses: { '200': { description: 'GST documents generated' } },
      },
    },
    '/invoices/{id}/cancel-irn': {
      post: {
        tags: ['Invoices'],
        summary: 'Cancel IRN for invoice',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['reason'], properties: { reason: { type: 'string' } } } } },
        },
        responses: { '200': { description: 'IRN cancelled' } },
      },
    },
    '/invoices/{id}/cancel-ewb': {
      post: {
        tags: ['Invoices'],
        summary: 'Cancel e-Way Bill for invoice',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['reason'], properties: { reason: { type: 'string' } } } } },
        },
        responses: { '200': { description: 'e-Way Bill cancelled' } },
      },
    },
    '/invoices/{id}/regenerate': {
      post: {
        tags: ['Invoices'],
        summary: 'Cancel and regenerate invoice (after delivery changes)',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        responses: { '200': { description: 'Invoice regenerated' } },
      },
    },
    '/invoices/{id}/gst-documents': {
      get: {
        tags: ['Invoices'],
        summary: 'Get GST documents for invoice',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        responses: { '200': { description: 'GST document list' } },
      },
    },
    '/invoices/credit-notes': {
      post: {
        tags: ['Invoices'],
        summary: 'Create credit note',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { '201': { description: 'Credit note created' } },
      },
    },
    '/invoices/credit-notes/{id}/approve': {
      put: {
        tags: ['Invoices'],
        summary: 'Approve credit note',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        responses: { '200': { description: 'Credit note approved' } },
      },
    },
    '/invoices/credit-notes/{id}/reject': {
      put: {
        tags: ['Invoices'],
        summary: 'Reject credit note',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        responses: { '200': { description: 'Credit note rejected' } },
      },
    },
    '/invoices/debit-notes': {
      post: {
        tags: ['Invoices'],
        summary: 'Create debit note',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { '201': { description: 'Debit note created' } },
      },
    },
    '/invoices/debit-notes/{id}/approve': {
      put: {
        tags: ['Invoices'],
        summary: 'Approve debit note',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        responses: { '200': { description: 'Debit note approved' } },
      },
    },
    '/invoices/debit-notes/{id}/reject': {
      put: {
        tags: ['Invoices'],
        summary: 'Reject debit note',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        responses: { '200': { description: 'Debit note rejected' } },
      },
    },

    // ─── Payments ────────────────────────────────────────────────────────
    '/payments': {
      get: {
        tags: ['Payments'],
        summary: 'List payments (paginated, filterable)',
        parameters: [
          { $ref: '#/components/parameters/page' },
          { $ref: '#/components/parameters/pageSize' },
          { name: 'customerId', in: 'query', schema: { type: 'string', format: 'uuid' } },
        ],
        responses: { '200': { description: 'Paginated payment list' } },
      },
      post: {
        tags: ['Payments'],
        summary: 'Record a payment',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { '201': { description: 'Payment recorded' } },
      },
    },
    '/payments/ledger/{customerId}': {
      get: {
        tags: ['Payments'],
        summary: 'Get customer ledger (invoices + payments)',
        parameters: [{ name: 'customerId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'Customer ledger' } },
      },
    },

    // ─── Inventory ───────────────────────────────────────────────────────
    '/inventory/summary/{date}': {
      get: {
        tags: ['Inventory'],
        summary: 'Get inventory summary for date',
        parameters: [{ name: 'date', in: 'path', required: true, schema: { type: 'string', format: 'date' } }],
        responses: { '200': { description: 'Inventory summaries by cylinder type' } },
      },
    },
    '/inventory/incoming-fulls': {
      post: {
        tags: ['Inventory'],
        summary: 'Record incoming full cylinders from plant',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { '201': { description: 'Incoming fulls recorded' } },
      },
    },
    '/inventory/outgoing-empties': {
      post: {
        tags: ['Inventory'],
        summary: 'Record outgoing empty cylinders to plant',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { '201': { description: 'Outgoing empties recorded' } },
      },
    },
    '/inventory/manual-adjustment': {
      post: {
        tags: ['Inventory'],
        summary: 'Record manual inventory adjustment',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { '201': { description: 'Adjustment recorded' } },
      },
    },
    '/inventory/cancelled-stock': {
      get: {
        tags: ['Inventory'],
        summary: 'Get cancelled stock events',
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string' } },
          { name: 'vehicleId', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'driverId', in: 'query', schema: { type: 'string', format: 'uuid' } },
        ],
        responses: { '200': { description: 'Cancelled stock list' } },
      },
    },
    '/inventory/cancelled-stock/return': {
      post: {
        tags: ['Inventory'],
        summary: 'Return cancelled stock to warehouse',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { '200': { description: 'Cancelled stock returned' } },
      },
    },
    '/inventory/threshold-alerts': {
      get: {
        tags: ['Inventory'],
        summary: 'Check inventory threshold alerts',
        responses: { '200': { description: 'Threshold alerts' } },
      },
    },
    '/inventory/customer-balances': {
      get: {
        tags: ['Inventory'],
        summary: 'Get customer cylinder balances',
        parameters: [{ name: 'customerId', in: 'query', schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'Customer balances' } },
      },
    },
    '/inventory/lock-summary': {
      put: {
        tags: ['Inventory'],
        summary: 'Lock/unlock daily inventory summary',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['cylinderTypeId', 'date', 'lock'],
                properties: {
                  cylinderTypeId: { type: 'string', format: 'uuid' },
                  date: { type: 'string', format: 'date' },
                  lock: { type: 'boolean' },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'Summary lock status updated' } },
      },
    },
    '/inventory/forecast': {
      get: {
        tags: ['Inventory'],
        summary: 'Get inventory demand forecast',
        responses: { '200': { description: 'Forecast data' } },
      },
    },
    '/inventory/reconciliation': {
      get: {
        tags: ['Inventory'],
        summary: 'Get reconciliation dashboard',
        responses: { '200': { description: 'Reconciliation data' } },
      },
    },

    // ─── Drivers ─────────────────────────────────────────────────────────
    '/drivers': {
      get: {
        tags: ['Drivers'],
        summary: 'List drivers',
        parameters: [{ name: 'status', in: 'query', schema: { type: 'string' } }],
        responses: { '200': { description: 'Driver list' } },
      },
      post: {
        tags: ['Drivers'],
        summary: 'Create driver',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['driverName', 'phone'],
                properties: {
                  driverName: { type: 'string' },
                  phone: { type: 'string' },
                  licenseNumber: { type: 'string' },
                  employmentType: { type: 'string' },
                  joiningDate: { type: 'string', format: 'date' },
                },
              },
            },
          },
        },
        responses: { '201': { description: 'Driver created' } },
      },
    },
    '/drivers/{id}': {
      get: {
        tags: ['Drivers'],
        summary: 'Get driver by ID',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        responses: { '200': { description: 'Driver details' } },
      },
      put: {
        tags: ['Drivers'],
        summary: 'Update driver',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { '200': { description: 'Driver updated' } },
      },
      delete: {
        tags: ['Drivers'],
        summary: 'Deactivate driver',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        responses: { '200': { description: 'Driver deactivated' } },
      },
    },
    '/drivers/{id}/availability': {
      put: {
        tags: ['Drivers'],
        summary: 'Toggle driver availability for today',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['available'], properties: { available: { type: 'boolean' } } },
            },
          },
        },
        responses: { '200': { description: 'Availability updated' } },
      },
    },
    '/drivers/{id}/performance': {
      get: {
        tags: ['Drivers'],
        summary: 'Get driver performance stats',
        parameters: [
          { $ref: '#/components/parameters/idPath' },
          { name: 'dateFrom', in: 'query', schema: { type: 'string', format: 'date' } },
          { name: 'dateTo', in: 'query', schema: { type: 'string', format: 'date' } },
        ],
        responses: { '200': { description: 'Driver performance data' } },
      },
    },
    '/drivers/assignments/list': {
      get: {
        tags: ['Drivers'],
        summary: 'List driver-vehicle assignments',
        parameters: [
          { name: 'date', in: 'query', schema: { type: 'string', format: 'date' } },
          { name: 'driverId', in: 'query', schema: { type: 'string', format: 'uuid' } },
        ],
        responses: { '200': { description: 'Assignment list' } },
      },
    },
    '/drivers/assignments': {
      post: {
        tags: ['Drivers'],
        summary: 'Create driver-vehicle assignment',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['driverId', 'vehicleId', 'assignmentDate'],
                properties: {
                  driverId: { type: 'string', format: 'uuid' },
                  vehicleId: { type: 'string', format: 'uuid' },
                  assignmentDate: { type: 'string', format: 'date' },
                },
              },
            },
          },
        },
        responses: { '201': { description: 'Assignment created' } },
      },
    },
    '/drivers/assignments/{id}/status': {
      put: {
        tags: ['Drivers'],
        summary: 'Update assignment status',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['status'],
                properties: {
                  status: {
                    type: 'string',
                    enum: ['dispatch_ready', 'loaded_and_dispatched', 'returned_inventory', 'reconciled', 'cancelled'],
                  },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'Assignment status updated' } },
      },
    },
    '/drivers/me/assignment': {
      get: {
        tags: ['Drivers'],
        summary: 'Get current driver\'s today assignment (mobile)',
        responses: { '200': { description: 'Today\'s assignment or null' } },
      },
    },
    '/drivers/me/vehicle-inventory': {
      get: {
        tags: ['Drivers'],
        summary: 'Get current driver\'s vehicle inventory (mobile)',
        responses: { '200': { description: 'Vehicle inventory' } },
      },
    },
    '/drivers/me/cancelled-stock': {
      get: {
        tags: ['Drivers'],
        summary: 'Get cancelled stock on driver\'s vehicle (mobile)',
        responses: { '200': { description: 'Cancelled stock events' } },
      },
    },

    // ─── Vehicles ────────────────────────────────────────────────────────
    '/vehicles': {
      get: {
        tags: ['Vehicles'],
        summary: 'List vehicles',
        parameters: [{ name: 'status', in: 'query', schema: { type: 'string' } }],
        responses: { '200': { description: 'Vehicle list' } },
      },
      post: {
        tags: ['Vehicles'],
        summary: 'Create vehicle',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['vehicleNumber'],
                properties: {
                  vehicleNumber: { type: 'string' },
                  vehicleType: { type: 'string' },
                  capacity: { type: 'integer' },
                },
              },
            },
          },
        },
        responses: { '201': { description: 'Vehicle created' } },
      },
    },
    '/vehicles/{id}': {
      get: {
        tags: ['Vehicles'],
        summary: 'Get vehicle by ID',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        responses: { '200': { description: 'Vehicle details' } },
      },
      put: {
        tags: ['Vehicles'],
        summary: 'Update vehicle',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { '200': { description: 'Vehicle updated' } },
      },
      delete: {
        tags: ['Vehicles'],
        summary: 'Deactivate vehicle',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        responses: { '200': { description: 'Vehicle deactivated' } },
      },
    },
    '/vehicles/{id}/inventory': {
      get: {
        tags: ['Vehicles'],
        summary: 'Get vehicle cylinder inventory',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        responses: { '200': { description: 'Vehicle inventory' } },
      },
      put: {
        tags: ['Vehicles'],
        summary: 'Update vehicle cylinder inventory',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['cylinderTypeId'],
                properties: {
                  cylinderTypeId: { type: 'string', format: 'uuid' },
                  fullQuantity: { type: 'integer' },
                  emptyQuantity: { type: 'integer' },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'Vehicle inventory updated' } },
      },
    },
    '/vehicles/{id}/cancelled-stock': {
      get: {
        tags: ['Vehicles'],
        summary: 'Get cancelled stock on vehicle',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        responses: { '200': { description: 'Cancelled stock events' } },
      },
    },

    // ─── Analytics ───────────────────────────────────────────────────────
    '/analytics/dashboard': {
      get: {
        tags: ['Analytics'],
        summary: 'Get dashboard statistics',
        responses: { '200': { description: 'Dashboard stats' } },
      },
    },
    '/analytics/header-metrics': {
      get: {
        tags: ['Analytics'],
        summary: 'Get header metrics (KPIs)',
        responses: { '200': { description: 'Header metrics' } },
      },
    },
    '/analytics/empty-cylinders': {
      get: {
        tags: ['Analytics'],
        summary: 'Empty cylinders report',
        responses: { '200': { description: 'Empty cylinders report' } },
      },
    },
    '/analytics/due-amounts': {
      get: {
        tags: ['Analytics'],
        summary: 'Due amounts report',
        responses: { '200': { description: 'Due amounts report' } },
      },
    },
    '/analytics/top-sales': {
      get: {
        tags: ['Analytics'],
        summary: 'Top sales report',
        parameters: [
          { name: 'dateFrom', in: 'query', required: true, schema: { type: 'string', format: 'date' } },
          { name: 'dateTo', in: 'query', required: true, schema: { type: 'string', format: 'date' } },
        ],
        responses: { '200': { description: 'Top sales report' } },
      },
    },
    '/analytics/driver-performance': {
      get: {
        tags: ['Analytics'],
        summary: 'Driver delivery performance report',
        parameters: [
          { name: 'dateFrom', in: 'query', schema: { type: 'string', format: 'date' } },
          { name: 'dateTo', in: 'query', schema: { type: 'string', format: 'date' } },
        ],
        responses: { '200': { description: 'Driver performance report' } },
      },
    },
    '/analytics/revenue-trends': {
      get: {
        tags: ['Analytics'],
        summary: 'Revenue trends over months',
        parameters: [{ name: 'months', in: 'query', schema: { type: 'integer', default: 12 } }],
        responses: { '200': { description: 'Revenue trends' } },
      },
    },
    '/analytics/customer-lifetime-value': {
      get: {
        tags: ['Analytics'],
        summary: 'Customer lifetime value report',
        responses: { '200': { description: 'CLV report' } },
      },
    },
    '/analytics/collections': {
      get: {
        tags: ['Analytics'],
        summary: 'Collections dashboard',
        responses: { '200': { description: 'Collections data' } },
      },
    },
    '/analytics/advanced-metrics': {
      get: {
        tags: ['Analytics'],
        summary: 'Advanced analytics metrics',
        responses: { '200': { description: 'Advanced metrics' } },
      },
    },
    '/analytics/export/due-amounts': {
      get: {
        tags: ['Analytics'],
        summary: 'Export due amounts data',
        responses: { '200': { description: 'Exportable due amounts data' } },
      },
    },
    '/analytics/export/collections': {
      get: {
        tags: ['Analytics'],
        summary: 'Export collections data',
        responses: { '200': { description: 'Exportable collections data' } },
      },
    },
    '/analytics/export/empty-cylinders': {
      get: {
        tags: ['Analytics'],
        summary: 'Export empty cylinders data',
        responses: { '200': { description: 'Exportable empty cylinders data' } },
      },
    },

    // ─── Settings ────────────────────────────────────────────────────────
    '/settings': {
      get: {
        tags: ['Settings'],
        summary: 'Get all distributor settings',
        responses: { '200': { description: 'Settings object' } },
      },
    },
    '/settings/{key}': {
      get: {
        tags: ['Settings'],
        summary: 'Get setting by key',
        parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Setting value' } },
      },
      put: {
        tags: ['Settings'],
        summary: 'Upsert setting by key',
        parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', properties: { value: {} } } } },
        },
        responses: { '200': { description: 'Setting saved' } },
      },
      delete: {
        tags: ['Settings'],
        summary: 'Delete setting by key',
        parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Setting deleted' } },
      },
    },
    '/settings/gst/credentials': {
      get: {
        tags: ['Settings'],
        summary: 'Get GST credentials (masked)',
        responses: { '200': { description: 'GST credentials' } },
      },
      put: {
        tags: ['Settings'],
        summary: 'Save GST credentials',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { '200': { description: 'GST credentials saved' } },
      },
    },
    '/settings/gst/mode': {
      put: {
        tags: ['Settings'],
        summary: 'Update GST mode (sandbox/production)',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['mode'], properties: { mode: { type: 'string' } } },
            },
          },
        },
        responses: { '200': { description: 'GST mode updated' } },
      },
    },
    '/settings/cylinder-thresholds/list': {
      get: {
        tags: ['Settings'],
        summary: 'List cylinder thresholds',
        responses: { '200': { description: 'Threshold list' } },
      },
    },
    '/settings/approval-workflows/list': {
      get: {
        tags: ['Settings'],
        summary: 'List approval workflows',
        responses: { '200': { description: 'Approval workflow list' } },
      },
    },
    '/settings/approval-workflows': {
      put: {
        tags: ['Settings'],
        summary: 'Update approval workflows',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { '200': { description: 'Workflows updated' } },
      },
    },
    '/settings/licenses/list': {
      get: {
        tags: ['Settings'],
        summary: 'List distributor licenses',
        responses: { '200': { description: 'License list' } },
      },
    },
    '/settings/licenses': {
      post: {
        tags: ['Settings'],
        summary: 'Create license',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { '201': { description: 'License created' } },
      },
    },
    '/settings/licenses/{id}': {
      put: {
        tags: ['Settings'],
        summary: 'Update license',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { '200': { description: 'License updated' } },
      },
      delete: {
        tags: ['Settings'],
        summary: 'Delete license',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        responses: { '200': { description: 'License deleted' } },
      },
    },

    // ─── Billing ─────────────────────────────────────────────────────────
    '/billing/cycles': {
      get: {
        tags: ['Billing'],
        summary: 'List billing cycles',
        parameters: [
          { $ref: '#/components/parameters/page' },
          { $ref: '#/components/parameters/pageSize' },
          { name: 'status', in: 'query', schema: { type: 'string' } },
          { name: 'distributorId', in: 'query', schema: { type: 'string', format: 'uuid' }, description: 'super_admin filter' },
        ],
        responses: { '200': { description: 'Billing cycle list' } },
      },
    },
    '/billing/cycles/{id}': {
      get: {
        tags: ['Billing'],
        summary: 'Get billing cycle by ID',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        responses: { '200': { description: 'Billing cycle details' } },
      },
    },
    '/billing/generate': {
      post: {
        tags: ['Billing'],
        summary: 'Generate billing cycle (super_admin)',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['distributorId', 'periodType', 'periodStartDate', 'periodEndDate'],
                properties: {
                  distributorId: { type: 'string', format: 'uuid' },
                  periodType: { type: 'string', enum: ['monthly', 'quarterly', 'half_yearly', 'yearly'] },
                  periodStartDate: { type: 'string', format: 'date' },
                  periodEndDate: { type: 'string', format: 'date' },
                },
              },
            },
          },
        },
        responses: { '201': { description: 'Billing cycle generated' } },
      },
    },
    '/billing/cycles/{id}/mark-paid': {
      put: {
        tags: ['Billing'],
        summary: 'Mark billing cycle as paid (super_admin)',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        responses: { '200': { description: 'Billing marked paid' } },
      },
    },
    '/billing/suspend/{distributorId}': {
      post: {
        tags: ['Billing'],
        summary: 'Suspend distributor for overdue billing (super_admin)',
        parameters: [{ name: 'distributorId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'Distributor suspended' } },
      },
    },
    '/billing/unsuspend/{distributorId}': {
      post: {
        tags: ['Billing'],
        summary: 'Unsuspend distributor (super_admin)',
        parameters: [{ name: 'distributorId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'Distributor unsuspended' } },
      },
    },
    '/billing/mark-overdue': {
      post: {
        tags: ['Billing'],
        summary: 'Mark overdue billing cycles (cron/super_admin)',
        responses: { '200': { description: 'Overdue cycles marked' } },
      },
    },

    // ─── Pending Actions ─────────────────────────────────────────────────
    '/pending-actions': {
      get: {
        tags: ['Pending Actions'],
        summary: 'List pending actions',
        parameters: [
          { name: 'module', in: 'query', schema: { type: 'string' } },
          { name: 'status', in: 'query', schema: { type: 'string' } },
          { name: 'severity', in: 'query', schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'Pending action list' } },
      },
    },
    '/pending-actions/overdue': {
      get: {
        tags: ['Pending Actions'],
        summary: 'List overdue SLA pending actions',
        responses: { '200': { description: 'Overdue actions' } },
      },
    },
    '/pending-actions/{id}/approve': {
      put: {
        tags: ['Pending Actions'],
        summary: 'Approve pending action',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        responses: { '200': { description: 'Action approved' } },
      },
    },
    '/pending-actions/{id}/resolve': {
      put: {
        tags: ['Pending Actions'],
        summary: 'Resolve pending action',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        requestBody: {
          content: { 'application/json': { schema: { type: 'object', properties: { notes: { type: 'string' } } } } },
        },
        responses: { '200': { description: 'Action resolved' } },
      },
    },
    '/pending-actions/{id}/reject': {
      put: {
        tags: ['Pending Actions'],
        summary: 'Reject pending action',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        requestBody: {
          content: { 'application/json': { schema: { type: 'object', properties: { notes: { type: 'string' } } } } },
        },
        responses: { '200': { description: 'Action rejected' } },
      },
    },

    // ─── Accountability ──────────────────────────────────────────────────
    '/accountability': {
      get: {
        tags: ['Accountability'],
        summary: 'List accountability logs',
        parameters: [
          { $ref: '#/components/parameters/page' },
          { $ref: '#/components/parameters/pageSize' },
          { name: 'status', in: 'query', schema: { type: 'string' } },
          { name: 'driverId', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'customerId', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'incidentType', in: 'query', schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'Accountability log list' } },
      },
      post: {
        tags: ['Accountability'],
        summary: 'Create accountability log',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { '201': { description: 'Log created' } },
      },
    },
    '/accountability/{id}': {
      get: {
        tags: ['Accountability'],
        summary: 'Get accountability log by ID',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        responses: { '200': { description: 'Accountability log details' } },
      },
    },
    '/accountability/{id}/resolve': {
      put: {
        tags: ['Accountability'],
        summary: 'Resolve accountability log',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { '200': { description: 'Log resolved' } },
      },
    },

    // ─── Delivery Workflow ───────────────────────────────────────────────
    '/delivery/customer/pending-confirmations': {
      get: {
        tags: ['Delivery Workflow'],
        summary: 'Get customer pending delivery confirmations',
        responses: { '200': { description: 'Pending confirmations' } },
      },
    },
    '/delivery/customer/confirm/{orderId}': {
      post: {
        tags: ['Delivery Workflow'],
        summary: 'Customer confirm/dispute delivery',
        parameters: [{ name: 'orderId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['confirmed'],
                properties: {
                  confirmed: { type: 'boolean' },
                  items: { type: 'array', items: { type: 'object' } },
                  disputeReason: { type: 'string' },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'Delivery confirmed or disputed' } },
      },
    },
    '/delivery/driver/vehicle-returned': {
      post: {
        tags: ['Delivery Workflow'],
        summary: 'Mark vehicle as returned from delivery',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['vehicleId'], properties: { vehicleId: { type: 'string', format: 'uuid' } } },
            },
          },
        },
        responses: { '200': { description: 'Vehicle marked returned' } },
      },
    },
    '/delivery/reconciliation/pending': {
      get: {
        tags: ['Delivery Workflow'],
        summary: 'Get vehicles pending reconciliation',
        responses: { '200': { description: 'Vehicles pending reconciliation' } },
      },
    },
    '/delivery/reconciliation/confirm/{vehicleId}': {
      post: {
        tags: ['Delivery Workflow'],
        summary: 'Confirm vehicle reconciliation',
        parameters: [{ name: 'vehicleId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['physicalStockConfirmed'],
                properties: {
                  physicalStockConfirmed: { type: 'boolean' },
                  notes: { type: 'string' },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'Reconciliation confirmed' } },
      },
    },

    // ─── Assignments ─────────────────────────────────────────────────────
    '/assignments/vehicle-mappings': {
      get: {
        tags: ['Assignments'],
        summary: 'Get recommended driver-vehicle mappings',
        parameters: [{ name: 'date', in: 'query', schema: { type: 'string', format: 'date' } }],
        responses: { '200': { description: 'Recommended mappings' } },
      },
    },
    '/assignments/vehicle-mappings/confirm': {
      post: {
        tags: ['Assignments'],
        summary: 'Confirm driver-vehicle mappings',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['date'],
                properties: {
                  date: { type: 'string', format: 'date' },
                  mappings: { type: 'array', items: { type: 'object' } },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'Mappings confirmed' } },
      },
    },
    '/assignments/order-recommendations': {
      post: {
        tags: ['Assignments'],
        summary: 'Get driver recommendations for orders',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['orderIds'],
                properties: { orderIds: { type: 'array', items: { type: 'string', format: 'uuid' } } },
              },
            },
          },
        },
        responses: { '200': { description: 'Order-driver recommendations' } },
      },
    },
    '/assignments/bulk-assign': {
      post: {
        tags: ['Assignments'],
        summary: 'Bulk assign orders to drivers with vehicles',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['assignments'],
                properties: {
                  assignments: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        orderId: { type: 'string', format: 'uuid' },
                        driverId: { type: 'string', format: 'uuid' },
                        vehicleId: { type: 'string', format: 'uuid' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'Bulk assignment results' } },
      },
    },

    // ─── Customer Portal ─────────────────────────────────────────────────
    '/customer-portal/dashboard': {
      get: {
        tags: ['Customer Portal'],
        summary: 'Customer dashboard',
        responses: { '200': { description: 'Customer dashboard stats' } },
      },
    },
    '/customer-portal/orders': {
      get: {
        tags: ['Customer Portal'],
        summary: 'List customer\'s orders',
        parameters: [
          { $ref: '#/components/parameters/page' },
          { $ref: '#/components/parameters/pageSize' },
          { name: 'status', in: 'query', schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'Customer order list' } },
      },
      post: {
        tags: ['Customer Portal'],
        summary: 'Place a new order',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['deliveryDate', 'items'],
                properties: {
                  deliveryDate: { type: 'string', format: 'date' },
                  specialInstructions: { type: 'string' },
                  items: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        cylinderTypeId: { type: 'string', format: 'uuid' },
                        quantity: { type: 'integer' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        responses: { '201': { description: 'Order placed' } },
      },
    },
    '/customer-portal/orders/{id}': {
      get: {
        tags: ['Customer Portal'],
        summary: 'Get customer order by ID',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        responses: { '200': { description: 'Order details' } },
      },
    },
    '/customer-portal/invoices': {
      get: {
        tags: ['Customer Portal'],
        summary: 'List customer\'s invoices',
        parameters: [
          { $ref: '#/components/parameters/page' },
          { $ref: '#/components/parameters/pageSize' },
          { name: 'status', in: 'query', schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'Customer invoice list' } },
      },
    },
    '/customer-portal/invoices/with-gst': {
      get: {
        tags: ['Customer Portal'],
        summary: 'List invoices with GST document details',
        parameters: [
          { name: 'dateFrom', in: 'query', schema: { type: 'string', format: 'date' } },
          { name: 'dateTo', in: 'query', schema: { type: 'string', format: 'date' } },
          { name: 'status', in: 'query', schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'Invoices with GST details' } },
      },
    },
    '/customer-portal/invoices/download-summary': {
      get: {
        tags: ['Customer Portal'],
        summary: 'Download invoice summary for date range',
        parameters: [
          { name: 'dateFrom', in: 'query', required: true, schema: { type: 'string', format: 'date' } },
          { name: 'dateTo', in: 'query', required: true, schema: { type: 'string', format: 'date' } },
        ],
        responses: { '200': { description: 'Invoice summary data' } },
      },
    },
    '/customer-portal/invoices/{id}': {
      get: {
        tags: ['Customer Portal'],
        summary: 'Get customer invoice by ID',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        responses: { '200': { description: 'Invoice details' } },
      },
    },
    '/customer-portal/payments': {
      get: {
        tags: ['Customer Portal'],
        summary: 'List customer\'s payments',
        parameters: [
          { $ref: '#/components/parameters/page' },
          { $ref: '#/components/parameters/pageSize' },
        ],
        responses: { '200': { description: 'Customer payment list' } },
      },
    },
    '/customer-portal/payments/{id}': {
      get: {
        tags: ['Customer Portal'],
        summary: 'Get customer payment by ID',
        parameters: [{ $ref: '#/components/parameters/idPath' }],
        responses: { '200': { description: 'Payment details' } },
      },
    },
    '/customer-portal/balance': {
      get: {
        tags: ['Customer Portal'],
        summary: 'Get customer cylinder balance',
        responses: { '200': { description: 'Cylinder balance' } },
      },
    },
    '/customer-portal/account': {
      get: {
        tags: ['Customer Portal'],
        summary: 'Get customer account details',
        responses: { '200': { description: 'Account info' } },
      },
      put: {
        tags: ['Customer Portal'],
        summary: 'Update customer profile (limited fields)',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  phone: { type: 'string' },
                  email: { type: 'string', format: 'email' },
                  shippingAddressLine1: { type: 'string' },
                  shippingAddressLine2: { type: 'string' },
                  shippingCity: { type: 'string' },
                  shippingState: { type: 'string' },
                  shippingPincode: { type: 'string' },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'Profile updated' } },
      },
    },
    '/customer-portal/distributor': {
      get: {
        tags: ['Customer Portal'],
        summary: 'Get distributor info for the customer',
        responses: { '200': { description: 'Distributor info' } },
      },
    },

    // ─── Contact ─────────────────────────────────────────────────────────
    '/contact': {
      post: {
        tags: ['Contact'],
        summary: 'Submit contact form (public)',
        security: [],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object' } } },
        },
        responses: { '200': { description: 'Contact form submitted' } },
      },
    },
  },
};

const swaggerSpec = swaggerDefinition;

// ─── super_admin Authentication Middleware for Swagger UI ────────────────────

async function requireSuperAdminForDocs(req: Request, res: Response, next: NextFunction) {
  // Allow static assets (CSS, JS, images) through without auth — they're public swagger-ui files
  const staticExts = ['.css', '.js', '.png', '.ico', '.map'];
  if (staticExts.some(ext => req.path.endsWith(ext))) {
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    // If no bearer token, check for token in query string (for swagger-ui initial load)
    const queryToken = req.query.token as string | undefined;
    if (queryToken) {
      try {
        const decoded = jwt.verify(queryToken, config.jwt.accessSecret) as JwtPayload;
        const user = await prisma.user.findUnique({
          where: { id: decoded.userId },
          select: { id: true, status: true, role: true },
        });
        if (user?.status === 'active' && user.role === 'super_admin') {
          return next();
        }
      } catch {
        // fall through to unauthorized
      }
    }
    return res.status(401).json({
      success: false,
      error: 'Authentication required. Pass Bearer token in Authorization header or ?token= query parameter.',
    });
  }

  const token = authHeader.slice(7);
  try {
    const decoded = jwt.verify(token, config.jwt.accessSecret) as JwtPayload;
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { id: true, status: true, role: true },
    });

    if (!user || user.status !== 'active') {
      return res.status(401).json({ success: false, error: 'User inactive or not found' });
    }

    if (user.role !== 'super_admin') {
      return res.status(403).json({ success: false, error: 'API documentation is restricted to super_admin users' });
    }

    next();
  } catch {
    return res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
}

// ─── Mount Swagger UI ───────────────────────────────────────────────────────

export function setupSwagger(app: Express): void {
  // Serve the raw OpenAPI JSON spec (also protected)
  app.get('/api/docs/swagger.json', requireSuperAdminForDocs, (_req, res) => {
    res.json(swaggerSpec);
  });

  // Swagger UI - protected by super_admin auth
  app.use(
    '/api/docs',
    requireSuperAdminForDocs,
    swaggerUi.serve,
    swaggerUi.setup(swaggerSpec, {
      customCss: '.swagger-ui .topbar { display: none }',
      customSiteTitle: 'GasLink API Documentation',
      swaggerOptions: {
        persistAuthorization: true,
      },
    }),
  );
}
