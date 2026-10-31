import { randomUUID } from 'node:crypto';
import { array, escapeHtml, HotmartClient, id, object, productId, providerArray, providerId, providerProductId, text } from './http.ts';
import {
  HotmartError, HotmartCoursePendingError, type CreateHotmartCourse, type CreateHotmartLesson, type HotmartClass,
  type HotmartCourse, type HotmartCourseDetail, type HotmartDependencies, type HotmartLesson,
  type HotmartMediaStatus, type HotmartMembership, type HotmartModule,
} from './types.ts';

const PRODUCT = 'https://api-product.vulcano.hotmart.com';
const SPACE = 'https://api-content-platform-space-gateway.cp.hotmart.com';
const CONTENT = 'https://api-club-content.cb.hotmart.com';
const PLAYER = 'https://api-gateway.play.hotmart.com';
const str = (value: unknown): string => typeof value === 'string' || typeof value === 'number' ? String(value) : '';
const number = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0;
const course = (raw: unknown): HotmartCourse => {
  const value = object(raw);
  return { id: providerProductId(value.id), name: str(value.name), ucode: str(value.ucode) || undefined, status: str(value.status) || undefined, subdomain: str(value.clubSubdomain) || undefined };
};
const lesson = (raw: unknown): HotmartLesson => {
  const value = object(raw);
  return { id: providerId(value.id ?? value.pageId), title: str(value.name ?? value.title), published: value.published === true || value.isPublished === true, order: number(value.pageOrder ?? value.order) };
};
const module = (raw: unknown, extra = false): HotmartModule => {
  const value = object(raw);
  return { id: providerId(value.id ?? value.moduleId), name: str(value.name), order: number(value.order), extra, lessons: [] };
};

/** Fixed first-party operations; callers never supply upstream URLs or HTTP methods. */
export function createHotmartService(token: string, deps: HotmartDependencies = {}) {
  const client = new HotmartClient(token, deps);

  async function listMemberships(): Promise<HotmartMembership[]> {
    const response = object(await client.json(`${SPACE}/rest/v1/admin/memberships/owner?page=0&size=100`));
    return providerArray(response.content).map(raw => {
      const value = object(raw);
      return { id: providerId(value.id), name: str(value.name), slug: providerId(value.slug) };
    });
  }

  async function createMembership(input: { name: string; slug: string }): Promise<HotmartMembership> {
    const name = text(input.name, 'O nome da área de membros', 100);
    const slug = id(input.slug, 'endereço da área de membros').toLowerCase();
    const response = object(await client.send(`${SPACE}/rest/v1/admin/memberships`, 'POST', { name, slug }));
    return { id: providerId(response.id), name: str(response.name) || name, slug: response.slug === undefined ? slug : providerId(response.slug) };
  }

  async function listCourses(): Promise<HotmartCourse[]> {
    const result: HotmartCourse[] = [];
    // Bound enumeration and avoid the legacy createClubDefault list side effect.
    for (let page = 0; page < 20; page++) {
      const response = object(await client.json(`${PRODUCT}/product/v2/product?page=${page}&rows=100`));
      const items = providerArray(response.data);
      for (const item of items) {
        const value = object(item);
        if (value.deleted === true) continue;
        // Product v2 returns legacy format IDs: 8 is a course/subscription,
        // whereas legacy 1 is an ebook. Creation's format.id enum is different.
        if (![8, 12, 17].includes(number(value.format ?? value.categoryId)) && !String(value.labelFormat).includes('membership')) continue;
        result.push(course(value));
      }
      if (items.length < 100) break;
    }
    return [...new Map(result.map(value => [value.id, value])).values()];
  }

  async function getCourseBasic(rawProductId: string): Promise<HotmartCourse> {
    const pid = productId(rawProductId);
    const membership = object(await client.json(`${SPACE}/rest/public/v1/memberships/products/${pid}`));
    const slug = providerId(membership.slug);
    const basic = course(await client.json(`${SPACE}/rest/v1/admin/memberships/${slug}/products/${pid}/basic`));
    if (!basic.subdomain) throw new HotmartError(409, 'hotmart_course_setup', 'Conclua a configuração da área de membros deste curso na Hotmart.');
    return { ...basic, membershipSlug: slug };
  }

  async function listModules(rawProductId: string): Promise<HotmartModule[]> {
    const pid = productId(rawProductId);
    const [normal, extra] = await Promise.all([
      client.json(`${CONTENT}/v4/modules?extra=false`, {}, { productId: pid }),
      client.json(`${CONTENT}/v4/modules?extra=true`, {}, { productId: pid }),
    ]);
    return [...providerArray(normal).map(raw => module(raw)), ...providerArray(extra).map(raw => module(raw, true))].sort((a, b) => a.order - b.order);
  }

  async function listClasses(rawProductId: string): Promise<HotmartClass[]> {
    const pid = productId(rawProductId);
    return providerArray(await client.json(`${CONTENT}/v4/membershipClass`, {}, { productId: pid })).map(raw => {
      const value = object(raw);
      return { id: providerId(value.hashId ?? value.id), name: value.name === 'membership.default.class.name' ? 'Turma padrão' : str(value.name), defaultClass: value.defaultClass === true };
    });
  }

  async function listLessons(rawProductId: string, moduleId: string): Promise<HotmartLesson[]> {
    const pid = productId(rawProductId);
    return providerArray(await client.json(`${CONTENT}/v4/modules/${id(moduleId)}/pages`, {}, { productId: pid })).map(lesson).sort((a, b) => a.order - b.order);
  }

  async function getCourse(rawProductId: string): Promise<HotmartCourseDetail> {
    const pid = productId(rawProductId);
    const [basic, modules, classes] = await Promise.all([getCourseBasic(pid), listModules(pid), listClasses(pid)]);
    if (modules.length > 150) throw new HotmartError(422, 'course_too_large', 'Este curso tem muitos módulos. Abra a estrutura na Hotmart.');
    // Batch rather than fan out hundreds of upstream requests at once.
    for (let offset = 0; offset < modules.length; offset += 5) {
      await Promise.all(modules.slice(offset, offset + 5).map(async item => { item.lessons = await listLessons(pid, item.id); }));
    }
    return { course: basic, modules, classes };
  }

  async function createModule(rawProductId: string, input: { name: string }): Promise<HotmartModule> {
    const pid = productId(rawProductId);
    const name = text(input.name, 'O nome do módulo', 200);
    const classes = await listClasses(pid);
    const chosen = classes.find(value => value.defaultClass) ?? classes[0];
    if (!chosen) throw new HotmartError(409, 'hotmart_class_missing', 'Crie uma turma para este curso na Hotmart antes de adicionar módulos.');
    const response = object(await client.send(`${CONTENT}/v4/modules`, 'POST', {
      name, classes: [chosen.id], mediaId: null, imageId: null, coverImageId: null,
      publicModule: false, extra: false, paidModule: false,
    }, { productId: pid }));
    return module({ ...response, name });
  }

  async function renameModule(rawProductId: string, moduleId: string, name: string): Promise<void> {
    const pid = productId(rawProductId);
    const mid = id(moduleId);
    await client.send(`${CONTENT}/v4/modules/${mid}/name`, 'PUT', { name: text(name, 'O nome do módulo', 200) }, { productId: pid });
  }

  async function reorderModules(rawProductId: string, moduleIds: string[]): Promise<void> {
    const pid = productId(rawProductId);
    if (!Array.isArray(moduleIds) || moduleIds.length > 30 || new Set(moduleIds).size !== moduleIds.length) throw new HotmartError(400, 'invalid_input', 'Confira a ordem dos módulos.');
    const modules = await listModules(pid);
    const desired = moduleIds.map(value => id(value));
    const current = modules.filter(value => !value.extra).map(value => value.id);
    if (current.length !== desired.length || desired.some(value => !current.includes(value))) throw new HotmartError(409, 'hotmart_structure_changed', 'A estrutura do curso mudou. Atualize os módulos antes de reorganizar.');
    for (let index = 0; index < desired.length; index++) {
      if (current[index] === desired[index]) continue;
      const target = current[index];
      await client.send(`${CONTENT}/v4/modules/${desired[index]}/order`, 'POST', {
        targetModuleOrderId: target, positionType: index === 0 ? 'FIRST' : 'AFTER_TARGET', newPreviousModuleId: index === 0 ? null : desired[index - 1],
      }, { productId: pid });
      current.splice(current.indexOf(desired[index]), 1);
      current.splice(index, 0, desired[index]);
    }
  }

  async function resolveCourseCreation(ucode: string, membershipSlug: string): Promise<HotmartCourse> {
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(ucode)) throw new HotmartError(400, 'invalid_input', 'Confira a solicitação do curso.');
    const slug = id(membershipSlug, 'área de membros');
    let found: HotmartCourse | undefined;
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        const value = object(await client.json(`https://api-vlc.hotmart.com/marketplace/rest/v1/product/ucode/${ucode}`));
        const raw = object(value.product ?? value);
        found = course(raw);
      } catch (error) {
        if (!(error instanceof HotmartError) || error.code !== 'hotmart_not_found') throw error;
      }
      if (found) break;
      await client.sleep(1000);
    }
    if (!found) throw new HotmartCoursePendingError(ucode, slug);
    let attached = false;
    try {
      const existing = object(await client.json(`${SPACE}/rest/public/v1/memberships/products/${found.id}`));
      attached = existing.slug === slug;
    } catch (error) {
      if (!(error instanceof HotmartError) || error.code !== 'hotmart_not_found') throw error;
    }
    if (!attached) await client.send(`${PRODUCT}/product/v1/new-clubs/${slug}/products/${found.id}?isUnderEmaMigration=false`, 'PUT', null);
    return { ...found, ucode, membershipSlug: slug, status: found.status ?? 'DRAFT' };
  }

  async function createCourse(input: CreateHotmartCourse, requestUcode: string = randomUUID()): Promise<HotmartCourse> {
    const name = text(input.name, 'O nome do curso', 100);
    const description = text(input.description, 'A descrição do curso', 10000, 200);
    const memberships = await listMemberships();
    const slug = id(input.membershipSlug, 'área de membros');
    if (!memberships.some(value => value.slug === slug)) throw new HotmartError(403, 'hotmart_forbidden', 'Selecione uma área de membros da sua conta.');
    if (!['pt_BR', 'en', 'es'].includes(input.locale) || !['BRL', 'USD', 'EUR'].includes(input.currency) || !Number.isFinite(input.price) || input.price <= 0 || input.price > 1_000_000) throw new HotmartError(400, 'invalid_input', 'Confira idioma, moeda e preço do curso.');
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(requestUcode)) throw new HotmartError(400, 'invalid_input', 'Confira a solicitação do curso.');
    const category = input.categoryId ?? 18;
    if (!Number.isInteger(category) || category < 1 || category > 25) throw new HotmartError(400, 'invalid_input', 'Selecione uma categoria válida.');
    // The creation wizard forwards the country option's numeric ID, not its
    // display name. The current country API identifies Brasil as ID 1.
    let targetCountry: number;
    if (input.targetCountry === undefined) targetCountry = 1;
    else if (typeof input.targetCountry === 'number' || /^\d+$/.test(String(input.targetCountry))) targetCountry = Number(input.targetCountry);
    else {
      const requested = text(input.targetCountry, 'O país do curso', 80).toLowerCase();
      const options = providerArray(await client.json('https://api-vlc.hotmart.com/userprofile/rest/v1/address/country'));
      targetCountry = Number(object(options.find(raw => String(object(raw).value).toLowerCase() === requested)).id);
    }
    if (!Number.isInteger(targetCountry) || targetCountry < 1 || targetCountry > 10000) throw new HotmartError(400, 'invalid_input', 'Selecione um país válido para o curso.');
    // Ask the current pricing API rather than fixing a regional minimum price.
    const modes = object(await client.json(`${PRODUCT}/product/v1/product/payment-mode?currency=${input.currency}&formatId=1&value=${input.price}&offer=false`));
    if (!array(modes.paymentModes).includes('PAY_IN_FULL') || input.price < number(modes.minimumCreditCardAmount)) throw new HotmartError(422, 'invalid_price', 'Confira o preço mínimo para esta moeda na Hotmart.');
    await client.send(`${PRODUCT}/product/v1/product`, 'POST', {
      productDetail: {
        ucode: requestUcode, name, description, contentLocale: input.locale.toUpperCase(), targetCountry, category, coverPhoto: null, format: { id: 1 },
      },
      offerPayment: {
        warranty: 7, paymentMode: 'PAY_IN_FULL', shoppingCartOpenPermanent: null,
        checkoutConfiguration: { vatValueEmbedded: false },
        detail: { value: { currencyCode: input.currency, value: input.price }, installmentCustomizationEnabled: false, disableConversion: false, lotOffer: {}, recoveryWithSmartInstallments: false, smartInstallmentTermsAgreed: false, maxInstallmentsRecovery: null, buyerInstallmentInterestRate: null },
      },
    });
    return resolveCourseCreation(requestUcode, slug);
  }

  async function createLesson(rawProductId: string, input: CreateHotmartLesson): Promise<HotmartLesson> {
    const pid = productId(rawProductId);
    const moduleId = id(input.moduleId);
    const title = text(input.title, 'O título da aula', 200);
    const description = text(input.description, 'A descrição da aula', 20000, 0);
    const fileId = id(input.fileId, 'vídeo');
    // Plain text input is escaped here; no creator-supplied HTML is forwarded.
    const content = description ? description.split(/\n\s*\n/).map(paragraph => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`).join('') : '';
    const response = object(await client.send(`${CONTENT}/v4/pages`, 'POST', {
      page: { name: title, content, moduleId, drippingConfigs: [] },
      backgroundImageId: null, complementaryReadings: [], tags: [], attachmentIdList: [], mediaIdList: [fileId], mentorshipSessionId: null,
    }, { productId: pid }));
    return { id: providerId(response.id), title, published: false, order: number(response.pageOrder) };
  }

  async function publishLesson(rawProductId: string, lessonId: string): Promise<void> {
    const pid = productId(rawProductId);
    await client.send(`${CONTENT}/v4/pages/published`, 'PUT', { modules: null, published: true, notifyEmail: false, pages: [id(lessonId)] }, { productId: pid });
  }

  async function getMediaStatus(rawProductId: string, mediaCode: string): Promise<HotmartMediaStatus> {
    const pid = productId(rawProductId);
    const code = id(mediaCode, 'vídeo');
    const response = object(await client.json(`${PLAYER}/v2/media/${code}/detail`, {}, { productId: pid }));
    const value = object(response.media ?? response);
    const status = str(value.status ?? value.mediaStatus ?? value.media_status).toUpperCase();
    if (!status) throw new HotmartError(502, 'invalid_provider_response', 'A Hotmart não confirmou o estado deste vídeo. Atualize o envio antes de tentar novamente.');
    return { mediaCode: code, status: ['READY', 'CONVERTED'].includes(status) ? 'ready' : ['FAILED', 'ERROR', 'DELETED'].includes(status) ? 'failed' : 'processing' };
  }

  return { listMemberships, createMembership, listCourses, getCourseBasic, getCourse, listModules, listClasses, listLessons, createModule, renameModule, reorderModules, createCourse, resolveCourseCreation, createLesson, publishLesson, getMediaStatus };
}
