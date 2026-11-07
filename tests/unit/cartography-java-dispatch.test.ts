import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CartographyModel, MapEdge } from '../../src/sdk/core/cartography.js';
import { runScan } from '../../src/cartography/scan.js';

/**
 * L'exécution d'un appel Java sur une interface ou une classe abstraite : méthode héritée d'un type parent,
 * implémentation par une classe abstraite intermédiaire, surcharge, implémentations multiples (ambiguës,
 * @Primary, nom du champ), homonymes d'un autre paquet, et appels vers une méthode absente des sources.
 */
const P = 'src/main/java/com/ex';
const FILES: Record<string, string> = {
  [`${P}/web/OrderController.java`]: `package com.ex.web;
import com.ex.service.*;
import org.springframework.web.bind.annotation.*;
@RestController @RequestMapping("/api/orders")
public class OrderController {
  private final OrderService orders;
  private final Notifier notifier;
  private final Notifier smsNotifier;
  private final Pricing pricing;
  private final Archive archive;
  public OrderController(OrderService orders, Notifier notifier, Notifier smsNotifier, Pricing pricing, Archive archive) {
    this.orders = orders; this.notifier = notifier; this.smsNotifier = smsNotifier; this.pricing = pricing; this.archive = archive;
  }
  @PostMapping public String create(@RequestBody String body) {
    notifier.send(body); smsNotifier.send(body); pricing.price(body); archive.store(body); orders.audit(body, 2);
    return orders.create(body);
  }
  @GetMapping public java.util.List<String> all() { return orders.findAll(); }
}`,
  [`${P}/service/BaseService.java`]: `package com.ex.service;
public interface BaseService<T> { java.util.List<T> findAll(); }`,
  [`${P}/service/OrderService.java`]: `package com.ex.service;
public interface OrderService extends BaseService<String> {
  String create(String body);
  void audit(String body);
  void audit(String body, int level);
}`,
  [`${P}/service/AbstractOrderService.java`]: `package com.ex.service;
public abstract class AbstractOrderService implements OrderService {
  public java.util.List<String> findAll() { return java.util.List.of(); }
}`,
  [`${P}/service/OrderServiceImpl.java`]: `package com.ex.service;
@org.springframework.stereotype.Service public class OrderServiceImpl extends AbstractOrderService {
  private final OrderRepository repo;
  public OrderServiceImpl(OrderRepository repo) { this.repo = repo; }
  @Override public String create(String body) { repo.save(new OrderEntity()); return body; }
  @Override public void audit(String body) { }
  @Override public void audit(String body, int level) { }
}`,
  [`${P}/service/Notifier.java`]: `package com.ex.service;
public interface Notifier { void send(String m); }`,
  [`${P}/service/MailNotifier.java`]: `package com.ex.service;
@org.springframework.stereotype.Component public class MailNotifier implements Notifier { public void send(String m) {} }`,
  [`${P}/service/SmsNotifier.java`]: `package com.ex.service;
@org.springframework.stereotype.Component public class SmsNotifier implements Notifier { public void send(String m) {} }`,
  // Un homonyme dans un autre paquet : son implémentation n'est jamais une candidate.
  [`${P}/other/Notifier.java`]: `package com.ex.other;
public interface Notifier { void send(String m); }`,
  [`${P}/other/PushNotifier.java`]: `package com.ex.other;
public class PushNotifier implements Notifier { public void send(String m) {} }`,
  [`${P}/service/Pricing.java`]: `package com.ex.service;
public interface Pricing { int price(String m); }`,
  [`${P}/service/StandardPricing.java`]: `package com.ex.service;
@org.springframework.context.annotation.Primary @org.springframework.stereotype.Component
public class StandardPricing implements Pricing { public int price(String m) { return 1; } }`,
  [`${P}/service/PromoPricing.java`]: `package com.ex.service;
@org.springframework.stereotype.Component public class PromoPricing implements Pricing { public int price(String m) { return 0; } }`,
  // Une seule sous-classe, abstraite : aucune exécution démontrée.
  [`${P}/service/Archive.java`]: `package com.ex.service;
public interface Archive { void store(String m); }`,
  [`${P}/service/AbstractArchive.java`]: `package com.ex.service;
public abstract class AbstractArchive implements Archive { public void store(String m) {} }`,
  [`${P}/service/OrderRepository.java`]: `package com.ex.service;
public interface OrderRepository extends org.springframework.data.jpa.repository.JpaRepository<OrderEntity, Long>, OrderRepositoryCustom {}`,
  // Un fragment de dépôt écrit à la main : son accès aux données est dans son implémentation.
  [`${P}/service/OrderRepositoryCustom.java`]: `package com.ex.service;
public interface OrderRepositoryCustom { java.util.List<OrderEntity> searchAdvanced(String q); }`,
  [`${P}/service/OrderRepositoryImpl.java`]: `package com.ex.service;
public class OrderRepositoryImpl implements OrderRepositoryCustom {
  private final jakarta.persistence.EntityManager em;
  public OrderRepositoryImpl(jakarta.persistence.EntityManager em) { this.em = em; }
  public java.util.List<OrderEntity> searchAdvanced(String q) {
    return em.createQuery("select o from OrderEntity o where o.id = :q", OrderEntity.class).getResultList();
  }
}`,
  [`${P}/service/SearchService.java`]: `package com.ex.service;
@org.springframework.stereotype.Service public class SearchService {
  private final OrderRepository repo;
  public SearchService(OrderRepository repo) { this.repo = repo; }
  public java.util.List<OrderEntity> search(String q) { return repo.searchAdvanced(q); }
}`,
  // Deux classes homonymes de paquets différents, injectées par leur nom qualifié.
  [`${P}/a/AuditService.java`]: `package com.ex.a;
@org.springframework.stereotype.Service public class AuditService { public void log(String m) {} }`,
  [`${P}/b/AuditService.java`]: `package com.ex.b;
@org.springframework.stereotype.Service public class AuditService { public void trace(String m) {} }`,
  [`${P}/web/AuditController.java`]: `package com.ex.web;
import org.springframework.web.bind.annotation.*;
@RestController @RequestMapping("/api/audit") public class AuditController {
  private final com.ex.a.AuditService a; private final com.ex.b.AuditService b;
  public AuditController(com.ex.a.AuditService a, com.ex.b.AuditService b) { this.a = a; this.b = b; }
  @GetMapping public void go() { a.log("x"); b.trace("y"); }
}`,
  [`${P}/service/OrderEntity.java`]: `package com.ex.service;
@jakarta.persistence.Entity @jakarta.persistence.Table(name = "orders") public class OrderEntity { @jakarta.persistence.Id Long id; }`,
};

let root: string;
let model: CartographyModel;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'qa-java-dispatch-'));
  for (const [file, text] of Object.entries(FILES)) {
    await mkdir(path.dirname(path.join(root, 'back', file)), { recursive: true });
    await writeFile(path.join(root, 'back', file), text);
  }
  ({ model } = await runScan({
    config: {
      schema: 1,
      sources: [
        {
          id: 'back',
          name: 'Back',
          layer: 'BACKEND',
          path: path.join(root, 'back'),
          include: [],
          enabled: true,
        },
      ],
    },
    allowedRoots: [root],
    incremental: false,
  }));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** « Classe.méthode » d'un nœud de méthode, ou le nom d'une classe. */
const short = (id: string): string => (id.includes('#') ? id.split('#').pop() : id.split(':').pop()) ?? id;
const calls = (from: string): MapEdge[] =>
  model.edges.filter((e) => e.kind === 'CALLS' && short(e.from) === from);
const to = (from: string): string[] =>
  calls(from)
    .map((e) => `${short(e.to)} ${e.confidence}`)
    .sort();

describe('Java dispatch: interfaces, inheritance, multiple implementations', () => {
  it('a method inherited from a parent interface is resolved, then executed by the implementation', () => {
    expect(to('OrderController.all')).toEqual([
      'AbstractOrderService.findAll PROBABLE',
      'BaseService.findAll CONFIRMED',
    ]);
    const executed = calls('OrderController.all').find((e) => e.confidence === 'PROBABLE');
    expect(executed?.reason).toContain('implémentation unique de BaseService.findAll');
  });

  it('an implementation through an abstract class is linked, overload by overload', () => {
    expect(to('OrderService.create')).toEqual(['OrderServiceImpl.create PROBABLE']);
    expect(to('OrderService.audit(String,int)')).toEqual(['OrderServiceImpl.audit(String,int) PROBABLE']);
    // La surcharge à un argument n'est pas appelée : aucune relation vers elle.
    expect(
      model.edges.some((e) => e.kind === 'CALLS' && short(e.to) === 'OrderServiceImpl.audit(String)'),
    ).toBe(false);
  });

  it('two implementations with no designation: both kept, ambiguous, none confirmed nor probable', () => {
    const dispatch = calls('Notifier.send');
    expect(dispatch.map((e) => `${short(e.to)} ${e.confidence}`).sort()).toEqual([
      'MailNotifier.send UNKNOWN',
      'SmsNotifier.send UNKNOWN',
    ]);
    expect(dispatch.every((e) => e.reason.includes('aucune n’est désignée'))).toBe(true);
    // L'homonyme d'un autre paquet n'est jamais candidat.
    expect(model.edges.some((e) => short(e.to) === 'PushNotifier.send')).toBe(false);
  });

  it('a field named after a bean designates it (Spring by-name rule), for that caller only', () => {
    const named = calls('OrderController.create').filter((e) => short(e.to) === 'SmsNotifier.send');
    expect(named.map((e) => e.confidence)).toEqual(['PROBABLE']);
    expect(named[0]?.reason).toContain('« smsNotifier »');
    expect(calls('OrderController.create').some((e) => short(e.to) === 'MailNotifier.send')).toBe(false);
  });

  it('@Primary designates one implementation for every caller', () => {
    expect(to('Pricing.price')).toEqual(['StandardPricing.price PROBABLE']);
    expect(calls('Pricing.price')[0]?.reason).toContain('@Primary');
  });

  it('an abstract class alone is never an executed implementation', () => {
    expect(to('Archive.store')).toEqual([]);
  });

  it('a method absent from the sources (library) is linked to its class, never lost', () => {
    expect(to('OrderServiceImpl.create')).toEqual(['OrderRepository PROBABLE']);
    const write = model.edges.find((e) => e.kind === 'WRITES' && short(e.from) === 'OrderServiceImpl.create');
    expect(write?.to).toMatch(/ENTITY:.*OrderEntity$/);
    expect(model.scan.unattached).toBeUndefined();
  });

  it('homonym classes of two packages stay two nodes; a qualified field type resolves its calls', () => {
    const services = model.nodes.filter((n) => n.kind === 'SERVICE' && n.name === 'AuditService');
    expect(services.map((n) => n.id.split(':').pop()).sort()).toEqual([
      'com.ex.a.AuditService',
      'com.ex.b.AuditService',
    ]);
    expect(services.every((n) => n.evidence.length === 1)).toBe(true);
    expect(to('AuditController.go')).toEqual(['AuditService.log CONFIRMED', 'AuditService.trace CONFIRMED']);
    // Une classe au nom unique garde son identifiant d'avant (nom simple).
    expect(model.nodes.some((n) => n.id === 'SERVICE:back:OrderServiceImpl')).toBe(true);
  });

  it('a repository fragment method runs in its implementation; its access is read there, not from its name', () => {
    expect(to('SearchService.search')).toEqual(['OrderRepositoryCustom.searchAdvanced CONFIRMED']);
    expect(to('OrderRepositoryCustom.searchAdvanced')).toEqual([
      'OrderRepositoryImpl.searchAdvanced PROBABLE',
    ]);
    const reads = (from: string) =>
      model.edges.filter((e) => e.kind === 'READS' && short(e.from) === from).map((e) => e.reason);
    expect(reads('OrderRepositoryImpl.searchAdvanced').join(' ')).toContain('JPQL');
    // Aucune lecture « d'après le nom de l'opération Spring Data » pour une méthode écrite à la main.
    expect(reads('SearchService.search')).toEqual([]);
  });

  it('every relation points to existing nodes', () => {
    const ids = new Set(model.nodes.map((n) => n.id));
    expect(model.edges.filter((e) => !ids.has(e.from) || !ids.has(e.to))).toEqual([]);
  });
});
